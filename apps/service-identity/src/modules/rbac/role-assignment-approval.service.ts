import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantScope } from '@taste-and-see/auth-sdk';
import type { AdminRoleApprovalRecord, AdminRoleApprovalStatus } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';
import { RbacApprovalEmitter, type RoleApprovalDescriptor } from './rbac-approval-emitter';
import { SENSITIVE_ROLE_NAMES } from './seed-catalog';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { RBAC_AUDIT_RESOURCE } from './audit-resources';

/** Scope type as stored on the identity tables. */
type DbScopeType = 'global' | 'tenant' | 'household';

export interface RequestGrantInput {
  readonly userId: string;
  readonly roleName: string;
  readonly scope: TenantScope;
  readonly expiresAt?: string | undefined;
  readonly reason: string;
  readonly actor: AuditActorContext;
}

export interface DecideInput {
  readonly approvalId: string;
  readonly actor: AuditActorContext;
  /** Active role NAMES from the caller's token claim (`requestContext.roles`). */
  readonly actorRoleNames: readonly string[];
  readonly note?: string | undefined;
}

/** The row slice every flow read selects. */
interface ApprovalRow {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly scopeType: DbScopeType;
  readonly scopeId: string | null;
  readonly expiresAt: Date | null;
  readonly requestedByUserId: string;
  readonly reason: string | null;
  readonly status: AdminRoleApprovalStatus;
  readonly approvedByUserId: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly userRoleId: string | null;
  readonly createdAt: Date;
  readonly role: { readonly name: string; readonly archivedAt: Date | null };
}

const APPROVAL_SELECT = {
  id: true,
  userId: true,
  roleId: true,
  scopeType: true,
  scopeId: true,
  expiresAt: true,
  requestedByUserId: true,
  reason: true,
  status: true,
  approvedByUserId: true,
  decidedAt: true,
  decisionNote: true,
  userRoleId: true,
  createdAt: true,
  role: { select: { name: true, archivedAt: true } },
} as const;

/** Bounded single page for the list read (mirrors the contract cap). */
const LIST_MAX = 500;

/**
 * Reviewer-required grant flow for SENSITIVE roles (TS-294; CLAUDE.md
 * §3.2 "Privilege escalation requires audit + reviewer signoff";
 * PDD §10.3) on the TS-024-followup-4 `role_assignment_approvals`
 * model. The direct grant surface (TS-292) 403s `super_admin` /
 * `finance`; this service is the only path that mints them.
 *
 * **The grant only becomes active on approval.** `requestGrant` writes
 * a pending-request row carrying the full grant parameters — NO
 * `user_roles` row exists until `approve` mints it, so token issuance
 * never sees a half-active grant.
 *
 * **Second-admin invariant.** `approve` rejects when the approver IS
 * the requester (403) — the core of the reviewer-signoff policy.
 *
 * **Approver privilege.** `rbac:write` alone must not mint a
 * `super_admin` grant by approving it (that would be the escalation
 * hole the flow exists to close). `approve` additionally requires the
 * approver to hold an active `super_admin` assignment — checked
 * against the caller's token roles claim (`requestContext.roles`,
 * populated by `AccessTokenGuard`; only ACTIVE assignments reach the
 * claim). `reject` is allowed for super_admin holders AND for the
 * requester (self-reject = withdrawing one's own request).
 *
 * **Concurrent-grant conflict.** If the grantee gained the role
 * between request and approval (the `user_roles_active_unique_idx`
 * P2002 fires on mint), the approval is marked REJECTED with a
 * conflict `decisionNote` in a follow-up transaction — never left
 * pending (a queue entry that can never succeed) — and the caller
 * gets a 409.
 *
 * **Audit.** Every mutation writes the structured-logger scaffold line
 * AND emits, in-tx: the durable
 * `identity.role_assignment_approval.requested` / `.decided` flow
 * events (TS-294 — the decided event carries BOTH the requester and
 * the decider ids) plus the `audit.action_recorded` event (TS-295)
 * that feeds the service-audit history store.
 *
 * Staleness: pending requests nobody decides are meant to expire
 * (`status = 'expired'`); the sweep is carved (TS-294-followup) — the
 * enum + decided event already support it.
 */
@Injectable()
export class RoleAssignmentApprovalService {
  private readonly logger = new Logger(RoleAssignmentApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: RbacApprovalEmitter,
    private readonly audit: AuditEmitter,
  ) {}

  /** Reviewer queue / history — bounded, oldest first (queue order). */
  async list(
    options: { readonly status?: AdminRoleApprovalStatus | undefined } = {},
  ): Promise<readonly AdminRoleApprovalRecord[]> {
    const rows: ApprovalRow[] = await this.prisma.roleAssignmentApproval.findMany({
      ...(options.status !== undefined ? { where: { status: options.status } } : {}),
      select: APPROVAL_SELECT,
      orderBy: { createdAt: 'asc' },
      take: LIST_MAX,
    });
    return rows.map(toWireRecord);
  }

  /**
   * Enter a sensitive-role grant into the pending-approval state.
   * Validation order: role exists (404) / archived (409) / MUST be
   * sensitive (400 — non-sensitive roles take the direct grant) →
   * grantee exists + live (404) → expiry future (400) → grantee does
   * not already hold the role actively (409 — nothing to approve) →
   * insert + requested event in one tx (duplicate pending P2002 → 409).
   */
  async requestGrant(input: RequestGrantInput): Promise<AdminRoleApprovalRecord> {
    const now = new Date();
    const role = await this.requireRole(input.roleName);
    if (!(SENSITIVE_ROLE_NAMES as readonly string[]).includes(role.name)) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `Role "${role.name}" is not a sensitive role — grant it directly via POST /api/v1/admin/role-assignments.`,
      });
    }
    await this.requireUser(input.userId);
    const expiresAt =
      input.expiresAt !== undefined ? parseFutureInstant(input.expiresAt, now) : null;
    const { scopeType, scopeId } = encodeScope(input.scope);

    const alreadyHeld = await this.prisma.userRole.findFirst({
      where: {
        userId: input.userId,
        roleId: role.id,
        scopeType,
        scopeId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (alreadyHeld !== null) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `User already holds an active "${role.name}" assignment in the requested scope — nothing to approve.`,
      });
    }

    let row: ApprovalRow;
    try {
      row = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const created: ApprovalRow = await tx.roleAssignmentApproval.create({
          data: {
            userId: input.userId,
            roleId: role.id,
            scopeType,
            scopeId,
            expiresAt,
            requestedByUserId: input.actor.actorUserId,
            reason: input.reason,
          },
          select: APPROVAL_SELECT,
        });
        await this.emitter.emitRequested(tx, descriptorFor(created), now);
        await this.audit.emit(tx, input.actor, {
          action: 'rbac_approval:request',
          resourceKind: RBAC_AUDIT_RESOURCE.approval,
          resourceId: created.id,
          before: null,
          after: toWireRecord(created),
        });
        return created;
      });
    } catch (err) {
      if (isPrismaKnownRequestError(err) && err.code === 'P2002') {
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `A pending approval request for "${role.name}" already exists for this user and scope.`,
        });
      }
      throw err;
    }

    this.logger.log(
      {
        action: 'rbac_approval:request',
        actorId: input.actor.actorUserId,
        approvalId: row.id,
        targetUserId: input.userId,
        role: role.name,
        scope: input.scope.type,
        expiresAt: expiresAt?.toISOString() ?? null,
        reason: input.reason,
      },
      'sensitive-role grant approval requested',
    );
    return toWireRecord(row);
  }

  /**
   * Second-admin approval: mints the real `user_roles` row and marks
   * the request approved, atomically. See the class doc for the
   * self-approve, approver-privilege, and conflict semantics.
   */
  async approve(input: DecideInput): Promise<AdminRoleApprovalRecord> {
    this.requireSuperAdminDecider(input);
    const row = await this.requirePending(input.approvalId);
    if (row.requestedByUserId === input.actor.actorUserId) {
      this.logger.warn(
        { approvalId: row.id, actorId: input.actor.actorUserId },
        'self-approval rejected: a second admin must approve',
      );
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail:
          'You requested this grant — a SECOND admin must approve it (CLAUDE.md §3.2 reviewer signoff).',
      });
    }

    const now = new Date();

    // The role may have been archived since the request — mint would
    // violate TS-290's archived-role policy, and the request can never
    // succeed. Terminal-reject it (same shape as the concurrent-grant
    // conflict) rather than 409-ing forever on a dead queue entry.
    if (row.role.archivedAt !== null) {
      await this.terminalReject(
        row,
        input.actor,
        `role "${row.role.name}" was archived after this request was filed`,
        now,
      );
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Role "${row.role.name}" has been archived since the request — the approval was rejected.`,
      });
    }

    let decided: ApprovalRow;
    try {
      decided = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const minted: { readonly id: string } = await tx.userRole.create({
          data: {
            userId: row.userId,
            roleId: row.roleId,
            scopeType: row.scopeType,
            scopeId: row.scopeId,
            grantedByUserId: input.actor.actorUserId,
            expiresAt: row.expiresAt,
          },
          select: { id: true },
        });
        const updated: ApprovalRow = await tx.roleAssignmentApproval.update({
          where: { id: row.id },
          data: {
            status: 'approved',
            approvedByUserId: input.actor.actorUserId,
            decidedAt: now,
            decisionNote: input.note ?? null,
            userRoleId: minted.id,
          },
          select: APPROVAL_SELECT,
        });
        await this.emitter.emitDecided(tx, {
          ...descriptorFor(row),
          status: 'approved',
          decidedByUserId: input.actor.actorUserId,
          decidedAt: now,
          userRoleId: minted.id,
        });
        await this.audit.emit(tx, input.actor, {
          action: 'rbac_approval:approve',
          resourceKind: RBAC_AUDIT_RESOURCE.approval,
          resourceId: row.id,
          before: toWireRecord(row),
          after: toWireRecord(updated),
        });
        return updated;
      });
    } catch (err) {
      if (isPrismaKnownRequestError(err) && err.code === 'P2002') {
        // The grantee gained the role between request and approval —
        // the active-unique index fired on mint. Terminal-reject so the
        // queue never carries an unsatisfiable entry.
        await this.terminalReject(
          row,
          input.actor,
          'superseded: user already holds this role in the requested scope',
          now,
        );
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: `User already holds an active "${row.role.name}" assignment in the requested scope — the approval was rejected as superseded.`,
        });
      }
      throw err;
    }

    // Audit line carries BOTH actor ids (TS-294 acceptance).
    this.logger.log(
      {
        action: 'rbac_approval:approve',
        actorId: input.actor.actorUserId,
        requestedByUserId: row.requestedByUserId,
        approvalId: row.id,
        targetUserId: row.userId,
        role: row.role.name,
        userRoleId: decided.userRoleId,
        note: input.note ?? null,
      },
      'sensitive-role grant approved — assignment minted',
    );
    return toWireRecord(decided);
  }

  /**
   * Reviewer rejection — or requester self-cancel (withdrawing one's
   * own request needs no second admin).
   */
  async reject(input: DecideInput): Promise<AdminRoleApprovalRecord> {
    const row = await this.requirePending(input.approvalId);
    const isRequester = row.requestedByUserId === input.actor.actorUserId;
    if (!isRequester) this.requireSuperAdminDecider(input);

    const now = new Date();
    const decided = await this.terminalReject(row, input.actor, input.note ?? null, now);

    this.logger.log(
      {
        action: 'rbac_approval:reject',
        actorId: input.actor.actorUserId,
        requestedByUserId: row.requestedByUserId,
        selfCancel: isRequester,
        approvalId: row.id,
        targetUserId: row.userId,
        role: row.role.name,
        note: input.note ?? null,
      },
      isRequester
        ? 'sensitive-role grant request withdrawn by its requester'
        : 'sensitive-role grant rejected by reviewer',
    );
    return toWireRecord(decided);
  }

  /** Mark a pending row rejected + emit the decided + audit events, atomically. */
  private async terminalReject(
    row: ApprovalRow,
    decider: AuditActorContext,
    note: string | null,
    now: Date,
  ): Promise<ApprovalRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const updated: ApprovalRow = await tx.roleAssignmentApproval.update({
        where: { id: row.id },
        data: {
          status: 'rejected',
          approvedByUserId: decider.actorUserId,
          decidedAt: now,
          decisionNote: note,
        },
        select: APPROVAL_SELECT,
      });
      await this.emitter.emitDecided(tx, {
        ...descriptorFor(row),
        status: 'rejected',
        decidedByUserId: decider.actorUserId,
        decidedAt: now,
        userRoleId: null,
      });
      await this.audit.emit(tx, decider, {
        action: 'rbac_approval:reject',
        resourceKind: RBAC_AUDIT_RESOURCE.approval,
        resourceId: row.id,
        before: toWireRecord(row),
        after: toWireRecord(updated),
      });
      return updated;
    });
  }

  private requireSuperAdminDecider(input: DecideInput): void {
    if (!input.actorRoleNames.includes('super_admin')) {
      this.logger.warn(
        { approvalId: input.approvalId, actorId: input.actor.actorUserId },
        'approval decision rejected: decider does not hold super_admin',
      );
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail:
          'Deciding a sensitive-role grant requires an active super_admin assignment — rbac:write alone is not sufficient.',
      });
    }
  }

  private async requirePending(approvalId: string): Promise<ApprovalRow> {
    const row: ApprovalRow | null = await this.prisma.roleAssignmentApproval.findUnique({
      where: { id: approvalId },
      select: APPROVAL_SELECT,
    });
    if (row === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Approval request ${truncateId(approvalId)} not found.`,
      });
    }
    if (row.status !== 'pending') {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Approval request ${truncateId(approvalId)} is already ${row.status}.`,
      });
    }
    return row;
  }

  private async requireRole(
    roleName: string,
  ): Promise<{ readonly id: string; readonly name: string }> {
    const role = await this.prisma.role.findUnique({
      where: { name: roleName },
      select: { id: true, name: true, archivedAt: true },
    });
    if (role === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Role "${roleName}" does not exist.`,
      });
    }
    if (role.archivedAt !== null) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Role "${roleName}" is archived and cannot be granted.`,
      });
    }
    return { id: role.id, name: role.name };
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
}

/** Event descriptor from a row (the request facts both events share). */
function descriptorFor(row: ApprovalRow): RoleApprovalDescriptor {
  return {
    approvalId: row.id,
    userId: row.userId,
    roleName: row.role.name,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    expiresAt: row.expiresAt,
    requestedByUserId: row.requestedByUserId,
  };
}

/** Project a row onto the wire DTO. */
function toWireRecord(row: ApprovalRow): AdminRoleApprovalRecord {
  return {
    id: row.id,
    userId: row.userId,
    roleName: row.role.name,
    scope: decodeScope(row.scopeType, row.scopeId),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    requestedByUserId: row.requestedByUserId,
    reason: row.reason,
    status: row.status,
    approvedByUserId: row.approvedByUserId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    userRoleId: row.userRoleId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Encode the auth-sdk scope union into the stored pair (mirrors TS-024). */
function encodeScope(scope: TenantScope): {
  readonly scopeType: DbScopeType;
  readonly scopeId: string | null;
} {
  switch (scope.type) {
    case 'global':
      return { scopeType: 'global', scopeId: null };
    case 'tenant':
      if (scope.tenantId.length === 0)
        throw badScope('Tenant scope requires a non-empty tenantId.');
      return { scopeType: 'tenant', scopeId: scope.tenantId };
    case 'household':
      if (scope.householdId.length === 0) {
        throw badScope('Household scope requires a non-empty householdId.');
      }
      return { scopeType: 'household', scopeId: scope.householdId };
  }
}

/** Decode the stored pair back into the contract's scope union. */
function decodeScope(
  scopeType: DbScopeType,
  scopeId: string | null,
): AdminRoleApprovalRecord['scope'] {
  switch (scopeType) {
    case 'global':
      return { type: 'global' };
    case 'tenant':
      if (scopeId === null) {
        throw new Error('role_assignment_approvals row has scopeType=tenant but scopeId is null');
      }
      return { type: 'tenant', tenantId: scopeId };
    case 'household':
      if (scopeId === null) {
        throw new Error(
          'role_assignment_approvals row has scopeType=household but scopeId is null',
        );
      }
      return { type: 'household', householdId: scopeId };
  }
}

function badScope(detail: string): BadRequestException {
  return new BadRequestException({
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    detail,
  });
}

function parseFutureInstant(iso: string, now: Date): Date {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'expiresAt must be a future ISO-8601 instant.',
    });
  }
  return parsed;
}

/** Duck-typed Prisma known-error guard (same rationale as TS-024's). */
interface PrismaKnownRequestError {
  readonly code: string;
}
function isPrismaKnownRequestError(err: unknown): err is PrismaKnownRequestError {
  if (typeof err !== 'object' || err === null) return false;
  return typeof (err as { code?: unknown }).code === 'string';
}

function truncateId(id: string): string {
  return id.length <= 32 ? id : `${id.slice(0, 29)}...`;
}
