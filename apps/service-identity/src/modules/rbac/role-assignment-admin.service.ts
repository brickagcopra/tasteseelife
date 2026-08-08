import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantScope } from '@taste-and-see/auth-sdk';
import type {
  AdminRoleAssignmentRecord,
  BulkRoleAssignmentOutcome,
  BulkRoleAssignmentRow,
  BulkRoleAssignmentVerdict,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';
import { RoleAssignmentService, type RoleAssignmentRecord } from './role-assignment.service';
import { SENSITIVE_ROLE_NAMES } from './seed-catalog';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { RBAC_AUDIT_RESOURCE } from './audit-resources';

export interface GrantSingleInput {
  readonly userId: string;
  readonly roleName: string;
  readonly scope: TenantScope;
  readonly expiresAt?: string | undefined;
  readonly reason?: string | undefined;
  readonly actor: AuditActorContext;
}

export interface RevokeInput {
  readonly assignmentId: string;
  readonly reason?: string | undefined;
  readonly actor: AuditActorContext;
}

/**
 * Admin role-ASSIGNMENT orchestration (TS-292; PRD §10.12; PDD §10.3).
 * A thin policy layer over `RoleAssignmentService` (which owns the
 * `user_roles` writes): sensitive-role rejection, user-existence
 * checks with clean problem details, per-row bulk validation, and the
 * per-grant audit scaffold.
 *
 * **Sensitive roles.** Granting `super_admin` / `finance` requires
 * reviewer signoff (CLAUDE.md §3.2) — the approval FLOW is TS-294 (on
 * the TS-024-followup-4 model). Until it ships those roles are simply
 * not grantable here: 403 with a pointer at the approval flow. This is
 * policy (who may perform the operation), not resource state — hence
 * 403 rather than the 409 used for archived/duplicate conflicts.
 *
 * **Bulk semantics: PARTIAL SUCCESS.** Each grant is an independent
 * ops action — row 40 failing must not undo rows 1–39 (re-running a
 * halved batch would 409 every already-applied row and bury the real
 * failure). Commit therefore applies rows sequentially, maps per-row
 * failures (409 duplicate → `conflict`, anything else → `error`) into
 * the outcome list, and never throws for a row.
 *
 * **Audit.** Every grant / revoke emits a durable
 * `audit.action_recorded` outbox event atomically with the write
 * (TS-295 — each write + emit pair runs in one `$transaction`, the
 * write threaded through `RoleAssignmentService`'s tx-client param)
 * plus the structured `logger.log` line the scaffold always carried.
 */
@Injectable()
export class RoleAssignmentAdminService {
  private readonly logger = new Logger(RoleAssignmentAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly assignments: RoleAssignmentService,
    private readonly audit: AuditEmitter,
  ) {}

  /** Every assignment for one user, projected onto the wire record. */
  async listForUser(
    userId: string,
    options: { readonly includeInactive?: boolean } = {},
  ): Promise<readonly AdminRoleAssignmentRecord[]> {
    await this.requireUser(userId);
    const records = await this.assignments.listForUser(userId, {
      includeInactive: options.includeInactive ?? false,
    });
    return records.map(toWireRecord);
  }

  /**
   * Single grant. Validation order: sensitive role (403) → user exists
   * (404) → expiry future (400) → delegate to
   * `RoleAssignmentService.grant` (role 404 / archived 409 / duplicate
   * 409).
   */
  async grantSingle(input: GrantSingleInput): Promise<AdminRoleAssignmentRecord> {
    this.rejectSensitiveRole(input.roleName);
    await this.requireUser(input.userId);
    const expiresAt =
      input.expiresAt !== undefined ? parseFutureInstant(input.expiresAt) : undefined;

    // Grant + audit event commit atomically (TS-295; CLAUDE.md §5.3).
    const { id } = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = await this.assignments.grant(
        {
          userId: input.userId,
          roleName: input.roleName,
          scope: input.scope,
          grantedByUserId: input.actor.actorUserId,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
        tx,
      );
      await this.audit.emit(tx, input.actor, {
        action: 'rbac_assignment:grant',
        resourceKind: RBAC_AUDIT_RESOURCE.assignment,
        resourceId: created.id,
        before: null,
        after: assignmentAuditSnapshot({
          userId: input.userId,
          roleName: input.roleName,
          scope: input.scope,
          expiresAt: expiresAt?.toISOString() ?? null,
          reason: input.reason ?? null,
          revokedAt: null,
        }),
      });
      return created;
    });

    this.logger.log(
      {
        action: 'rbac_assignment:grant',
        actorId: input.actor.actorUserId,
        assignmentId: id,
        userId: input.userId,
        role: input.roleName,
        scope: input.scope.type,
        expiresAt: expiresAt?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
      'role assignment granted via admin surface',
    );

    const record = await this.findRecord(input.userId, id);
    if (record === null) {
      // The grant just succeeded; not finding it means concurrent
      // deletion — surface loudly rather than fabricate a record.
      throw new Error(`assignment ${id} vanished between grant and read-back`);
    }
    return record;
  }

  /** Revoke by id. 404 for unknown ids; idempotent on already-revoked. */
  async revoke(input: RevokeInput): Promise<{ readonly revoked: boolean }> {
    // Fuller select than an existence probe — the row facts feed the
    // audit event's before/after snapshots.
    const row: {
      readonly id: string;
      readonly userId: string;
      readonly scopeType: 'global' | 'tenant' | 'household';
      readonly scopeId: string | null;
      readonly expiresAt: Date | null;
      readonly role: { readonly name: string };
    } | null = await this.prisma.userRole.findUnique({
      where: { id: input.assignmentId },
      select: {
        id: true,
        userId: true,
        scopeType: true,
        scopeId: true,
        expiresAt: true,
        role: { select: { name: true } },
      },
    });
    if (row === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Role assignment ${truncateId(input.assignmentId)} not found.`,
      });
    }

    // Revoke + audit event commit atomically; the idempotent re-revoke
    // no-op emits nothing (no state changed — nothing to audit).
    const result = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const outcome = await this.assignments.revoke(
        {
          assignmentId: input.assignmentId,
          revokedByUserId: input.actor.actorUserId,
        },
        tx,
      );
      if (outcome.revoked) {
        const facts = {
          userId: row.userId,
          roleName: row.role.name,
          scopeType: row.scopeType,
          scopeId: row.scopeId,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        };
        await this.audit.emit(tx, input.actor, {
          action: 'rbac_assignment:revoke',
          resourceKind: RBAC_AUDIT_RESOURCE.assignment,
          resourceId: input.assignmentId,
          before: { ...facts, revokedAt: null },
          after: {
            ...facts,
            revokedAt: outcome.revokedAt?.toISOString() ?? null,
            reason: input.reason ?? null,
          },
        });
      }
      return outcome;
    });

    this.logger.log(
      {
        action: 'rbac_assignment:revoke',
        actorId: input.actor.actorUserId,
        assignmentId: input.assignmentId,
        alreadyRevoked: !result.revoked,
        reason: input.reason ?? null,
      },
      'role assignment revoke via admin surface',
    );
    return { revoked: result.revoked };
  }

  /**
   * Read-only per-row validation of a parsed CSV batch. NO writes —
   * gated `rbac:read` at the controller so a reviewer can sanity-check
   * a sheet without grant rights.
   */
  async bulkPreview(
    rows: readonly BulkRoleAssignmentRow[],
  ): Promise<readonly BulkRoleAssignmentVerdict[]> {
    return this.validateRows(rows);
  }

  /**
   * Apply a batch row-by-row (partial success — see class doc).
   * Invalid rows become `error` outcomes without touching the DB;
   * valid rows grant sequentially, translating the duplicate-active
   * 409 into a `conflict` outcome.
   */
  async bulkCommit(
    rows: readonly BulkRoleAssignmentRow[],
    actor: AuditActorContext,
  ): Promise<readonly BulkRoleAssignmentOutcome[]> {
    const verdicts = await this.validateRows(rows);
    const outcomes: BulkRoleAssignmentOutcome[] = [];

    for (const verdict of verdicts) {
      if (!verdict.ok || verdict.normalized === null) {
        outcomes.push({
          index: verdict.index,
          status: 'error',
          assignmentId: null,
          message: verdict.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
        });
        continue;
      }

      const n = verdict.normalized;
      try {
        // Per-row transaction — grant + audit event commit atomically,
        // and a failed row rolls back alone (bulk stays partial-success).
        const { id } = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
          const created = await this.assignments.grant(
            {
              userId: n.userId,
              roleName: n.roleName,
              scope: n.scope,
              grantedByUserId: actor.actorUserId,
              ...(n.expiresAt !== null ? { expiresAt: new Date(n.expiresAt) } : {}),
            },
            tx,
          );
          await this.audit.emit(tx, actor, {
            action: 'rbac_assignment:grant',
            resourceKind: RBAC_AUDIT_RESOURCE.assignment,
            resourceId: created.id,
            before: null,
            after: assignmentAuditSnapshot({
              userId: n.userId,
              roleName: n.roleName,
              scope: n.scope,
              expiresAt: n.expiresAt,
              reason: null,
              revokedAt: null,
            }),
          });
          return created;
        });
        this.logger.log(
          {
            action: 'rbac_assignment:grant',
            actorId: actor.actorUserId,
            assignmentId: id,
            userId: n.userId,
            role: n.roleName,
            scope: n.scope.type,
            expiresAt: n.expiresAt,
            bulkIndex: verdict.index,
          },
          'role assignment granted via bulk commit',
        );
        outcomes.push({ index: verdict.index, status: 'granted', assignmentId: id, message: null });
      } catch (err) {
        const mapped = mapRowFailure(err);
        this.logger.warn(
          {
            action: 'rbac_assignment:bulk_row_rejected',
            actorId: actor.actorUserId,
            userId: n.userId,
            role: n.roleName,
            bulkIndex: verdict.index,
            status: mapped.status,
            message: mapped.message,
          },
          'bulk role-assignment row rejected',
        );
        outcomes.push({
          index: verdict.index,
          status: mapped.status,
          assignmentId: null,
          message: mapped.message,
        });
      }
    }

    return outcomes;
  }

  /**
   * Shared per-row semantic validation: scope shape, expiry parse +
   * future check, user / role catalog membership (batched lookups —
   * two `findMany` calls per batch, not two per row), sensitive-role
   * policy, and duplicate-within-file detection.
   */
  private async validateRows(
    rows: readonly BulkRoleAssignmentRow[],
  ): Promise<readonly BulkRoleAssignmentVerdict[]> {
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const roleNames = [...new Set(rows.map((r) => r.roleName))];

    // Explicit annotations pin the structural shapes Prisma returns
    // under the `select` clauses (repo idiom — the extended client's
    // overloads collapse to loose types under this tsconfig).
    const [users, roles]: [
      ReadonlyArray<{ id: string; deletedAt: Date | null }>,
      ReadonlyArray<{ name: string; archivedAt: Date | null }>,
    ] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, deletedAt: true },
      }),
      this.prisma.role.findMany({
        where: { name: { in: roleNames } },
        select: { name: true, archivedAt: true },
      }),
    ]);
    const liveUsers = new Set(users.filter((u) => u.deletedAt === null).map((u) => u.id));
    const roleByName = new Map(roles.map((r) => [r.name, r]));

    const seenKeys = new Set<string>();
    const now = new Date();

    return rows.map((row, index): BulkRoleAssignmentVerdict => {
      const errors: Array<{
        field: 'userId' | 'roleName' | 'scopeType' | 'scopeId' | 'expiresAt' | 'row';
        message: string;
      }> = [];

      // Scope shape.
      let scope: TenantScope | null = null;
      if (row.scopeType === 'global') {
        if (row.scopeId !== null) {
          errors.push({ field: 'scopeId', message: 'global scope must not carry a scopeId' });
        } else {
          scope = { type: 'global' };
        }
      } else if (row.scopeType === 'tenant') {
        if (row.scopeId === null) {
          errors.push({ field: 'scopeId', message: 'tenant scope requires a scopeId' });
        } else {
          scope = { type: 'tenant', tenantId: row.scopeId };
        }
      } else if (row.scopeType === 'household') {
        if (row.scopeId === null) {
          errors.push({ field: 'scopeId', message: 'household scope requires a scopeId' });
        } else {
          scope = { type: 'household', householdId: row.scopeId };
        }
      } else {
        errors.push({
          field: 'scopeType',
          message: `unknown scope type "${row.scopeType}" — expected global, tenant, or household`,
        });
      }

      // Expiry.
      let expiresAt: string | null = null;
      if (row.expiresAt !== null) {
        const parsed = new Date(row.expiresAt);
        if (Number.isNaN(parsed.getTime())) {
          errors.push({ field: 'expiresAt', message: 'not a parseable ISO-8601 instant' });
        } else if (parsed.getTime() <= now.getTime()) {
          errors.push({ field: 'expiresAt', message: 'expiry must be in the future' });
        } else {
          expiresAt = parsed.toISOString();
        }
      }

      // Catalog membership + policy.
      if (!liveUsers.has(row.userId)) {
        errors.push({ field: 'userId', message: 'no live user with this id' });
      }
      if ((SENSITIVE_ROLE_NAMES as readonly string[]).includes(row.roleName)) {
        errors.push({
          field: 'roleName',
          message: `"${row.roleName}" is a sensitive role — request it via the reviewer-approval flow (POST /api/v1/admin/role-approvals, TS-294); it cannot be granted here`,
        });
      } else {
        const role = roleByName.get(row.roleName);
        if (role === undefined) {
          errors.push({ field: 'roleName', message: 'no role with this name' });
        } else if (role.archivedAt !== null) {
          errors.push({ field: 'roleName', message: 'role is archived and cannot be granted' });
        }
      }

      // Duplicate within the file (same user + role + scope pair).
      const key = `${row.userId} ${row.roleName} ${row.scopeType} ${row.scopeId ?? ''}`;
      if (seenKeys.has(key)) {
        errors.push({ field: 'row', message: 'duplicate of an earlier row in this file' });
      }
      seenKeys.add(key);

      const ok = errors.length === 0 && scope !== null;
      return {
        index,
        ok,
        errors,
        normalized:
          ok && scope !== null
            ? { userId: row.userId, roleName: row.roleName, scope, expiresAt }
            : null,
      };
    });
  }

  private rejectSensitiveRole(roleName: string): void {
    if ((SENSITIVE_ROLE_NAMES as readonly string[]).includes(roleName)) {
      this.logger.warn(
        { role: roleName },
        'sensitive-role grant rejected: reviewer-approval flow required',
      );
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: `Role "${roleName}" is sensitive — request it via POST /api/v1/admin/role-approvals (reviewer-approval flow, TS-294); it cannot be granted directly.`,
      });
    }
  }

  private async requireUser(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deletedAt: true },
    });
    if (user === null || user.deletedAt !== null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `User ${truncateId(userId)} not found.`,
      });
    }
  }

  private async findRecord(
    userId: string,
    assignmentId: string,
  ): Promise<AdminRoleAssignmentRecord | null> {
    const records = await this.assignments.listForUser(userId, { includeInactive: true });
    const match = records.find((r) => r.id === assignmentId);
    return match === undefined ? null : toWireRecord(match);
  }
}

/**
 * The DTO-projected assignment snapshot an audit event carries as its
 * before/after diff (CLAUDE.md §3.3 — never raw Prisma rows).
 */
function assignmentAuditSnapshot(facts: {
  readonly userId: string;
  readonly roleName: string;
  readonly scope: TenantScope;
  readonly expiresAt: string | null;
  readonly reason: string | null;
  readonly revokedAt: string | null;
}): Record<string, unknown> {
  return {
    userId: facts.userId,
    roleName: facts.roleName,
    scopeType: facts.scope.type,
    scopeId:
      facts.scope.type === 'tenant'
        ? facts.scope.tenantId
        : facts.scope.type === 'household'
          ? facts.scope.householdId
          : null,
    expiresAt: facts.expiresAt,
    reason: facts.reason,
    revokedAt: facts.revokedAt,
  };
}

/** Project a service record onto the wire DTO. */
function toWireRecord(record: RoleAssignmentRecord): AdminRoleAssignmentRecord {
  return {
    id: record.id,
    userId: record.userId,
    roleName: record.assignment.name,
    scope: record.assignment.scope,
    active: record.active,
    grantedByUserId: record.grantedByUserId,
    expiresAt: record.assignment.expiresAt ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Map a per-row grant failure onto the outcome status. The duplicate
 * active-assignment 409 (TS-024-followup-3 index) is a `conflict` —
 * the desired end-state already holds. Everything else is `error`.
 */
function mapRowFailure(err: unknown): {
  readonly status: 'conflict' | 'error';
  readonly message: string;
} {
  if (err instanceof ConflictException) {
    return { status: 'conflict', message: problemDetail(err) };
  }
  if (err instanceof HttpException) {
    return { status: 'error', message: problemDetail(err) };
  }
  // Non-HTTP failure (DB down, bug) — still per-row, but generic; the
  // underlying error is logged by the caller.
  return { status: 'error', message: 'internal error applying this row' };
}

function problemDetail(err: HttpException): string {
  const body = err.getResponse();
  if (typeof body === 'object' && body !== null && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string') return detail;
  }
  return err.message;
}

function parseFutureInstant(iso: string): Date {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'expiresAt must be a future ISO-8601 instant.',
    });
  }
  return parsed;
}

function truncateId(id: string): string {
  return id.length <= 32 ? id : `${id.slice(0, 29)}...`;
}
