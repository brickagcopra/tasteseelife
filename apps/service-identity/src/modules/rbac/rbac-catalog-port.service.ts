import { Injectable, Logger } from '@nestjs/common';
import { SYSTEM_ROLE_NAMES } from '@taste-and-see/auth-sdk';
import {
  RBAC_CATALOG_FORMAT_VERSION,
  RbacCatalogEnvelopeSchema,
  type RbacCatalogEnvelope,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService } from '../../prisma/prisma.service';
import { SENSITIVE_ROLE_NAMES, formatPermission } from './seed-catalog';
import {
  applyRbacCatalog,
  type RbacCatalogInput,
  type RbacSeedClient,
  type RbacSeedReport,
} from './seed';
import type { AuditActor } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { RBAC_AUDIT_RESOURCE } from './audit-resources';

/**
 * RBAC catalog import/export ("port") service (TS-299; PRD §10.12;
 * PDD §10.3) — cross-environment parity tooling over the portable
 * envelope in `packages/contracts/src/http/admin-rbac-catalog.schema.ts`.
 *
 * **Export** projects the live catalog (permissions + non-archived
 * roles, system AND custom) onto the id-free envelope. Archived roles
 * are env-state, not definition — excluded.
 *
 * **Import** shares the seed's reconcile core (`applyRbacCatalog`):
 * upsert-by-natural-key, attach/detach diff per role, NEVER deletes.
 * Rows present in the target but absent from the envelope surface as
 * warnings, not removals. The apply runs in ONE transaction with one
 * `audit.action_recorded` per changed role (`rbac_role:create` /
 * `rbac_role:update` — per-role granularity keeps every diff far under
 * the 64 KiB audit payload cap; a single bulk event would blow it and
 * roll the import back). Unchanged roles emit nothing.
 *
 * **Guardrails.**
 *  - `isSystem` is authoritative from the TARGET (or, for roles the
 *    target doesn't know, from the auth-sdk `SYSTEM_ROLE_NAMES` list).
 *    A file claiming `isSystem: true` for an unrecognised name is a
 *    validation error, never honored. Custom roles always land
 *    `isSystem: false`.
 *  - Any diff altering a system role — including the
 *    `SENSITIVE_ROLE_NAMES` set, and above all `super_admin`'s
 *    permission set — is refused unless the operator explicitly passes
 *    `allowSystem` (the CLI's `--allow-system`). This is a BIGGER
 *    footgun than anything `rbac:write` can do (the HTTP surface
 *    refuses system roles outright), which is exactly why import is
 *    CLI-only and the flag is explicit.
 *  - Roles archived in the target are read-only everywhere; an
 *    envelope referencing one is a validation error.
 *
 * Import is DELIBERATELY not exposed over HTTP — only
 * `exportCatalog` backs an endpoint (`GET /api/v1/admin/rbac-catalog/
 * export`, `rbac:read`). Import runs via the `rbac:catalog` CLI
 * (`src/scripts/rbac-catalog.ts`) with direct DB access, wrapped in a
 * K8s Job for staging/prod (same ops posture as `seed:rbac`).
 */
@Injectable()
export class RbacCatalogPortService {
  private readonly logger = new Logger(RbacCatalogPortService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEmitter,
  ) {}

  /**
   * Project the live catalog onto the portable envelope. `now` is
   * injected (never `new Date()` internally) so callers control the
   * provenance stamp and tests stay deterministic.
   */
  async exportCatalog(now: Date): Promise<RbacCatalogEnvelope> {
    const permissions: ReadonlyArray<TargetPermissionRow> = await this.prisma.permission.findMany({
      select: { resource: true, action: true, description: true },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
    const roles: ReadonlyArray<Omit<TargetRoleRow, 'archivedAt'>> = await this.prisma.role.findMany(
      {
        where: { archivedAt: null },
        select: {
          name: true,
          description: true,
          isSystem: true,
          rolePermissions: {
            select: { permission: { select: { resource: true, action: true } } },
          },
        },
        orderBy: { name: 'asc' },
      },
    );

    const envelope: RbacCatalogEnvelope = {
      formatVersion: RBAC_CATALOG_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      permissions: permissions.map((p) => ({
        resource: p.resource,
        action: p.action,
        description: p.description,
      })),
      roles: roles.map((r) => ({
        name: r.name,
        description: r.description,
        isSystem: r.isSystem,
        permissions: r.rolePermissions.map((rp) => formatPermission(rp.permission)).sort(),
      })),
    };
    // Boundary check (repo idiom): a projection that drifts from the
    // contract must fail here, not in a consumer.
    const parsed = RbacCatalogEnvelopeSchema.parse(envelope);
    this.logger.log(
      { permissions: parsed.permissions.length, roles: parsed.roles.length },
      'rbac catalog exported',
    );
    return parsed;
  }

  /**
   * Compute what an import WOULD do — reads only, writes nothing. This
   * is the dry-run surface and the safety gate: since role-definition
   * edits have no server-side approval flow, reviewing the plan is the
   * review step.
   */
  async planImport(envelope: RbacCatalogEnvelope): Promise<RbacCatalogImportPlan> {
    const targetPermissions: ReadonlyArray<TargetPermissionRow> =
      await this.prisma.permission.findMany({
        select: { resource: true, action: true, description: true },
      });
    const targetRoles: ReadonlyArray<TargetRoleRow> = await this.prisma.role.findMany({
      select: {
        name: true,
        description: true,
        isSystem: true,
        archivedAt: true,
        rolePermissions: {
          select: { permission: { select: { resource: true, action: true } } },
        },
      },
    });

    const targetPermByKey = new Map<string, TargetPermissionRow>(
      targetPermissions.map((p) => [formatPermission(p), p]),
    );
    const targetRoleByName = new Map<string, TargetRoleRow>(targetRoles.map((r) => [r.name, r]));
    const systemRoleNameSet = new Set<string>(SYSTEM_ROLE_NAMES);
    const sensitiveRoleNameSet = new Set<string>(SENSITIVE_ROLE_NAMES);

    const permissionsToCreate: string[] = [];
    const permissionDescriptionUpdates: string[] = [];
    for (const p of envelope.permissions) {
      const key = `${p.resource}:${p.action}`;
      const target = targetPermByKey.get(key);
      if (target === undefined) {
        permissionsToCreate.push(key);
      } else if (target.description !== p.description) {
        permissionDescriptionUpdates.push(key);
      }
    }

    const knownPermissionKeys = new Set<string>([
      ...targetPermByKey.keys(),
      ...envelope.permissions.map((p) => `${p.resource}:${p.action}`),
    ]);

    const errors: string[] = [];
    const roleDiffs: RbacCatalogRoleDiff[] = [];
    const unchangedRoles: string[] = [];
    const systemRoleChanges: string[] = [];

    for (const role of envelope.roles) {
      const target = targetRoleByName.get(role.name);

      // ── isSystem resolution (target-authoritative).
      let effectiveIsSystem: boolean;
      if (target !== undefined) {
        effectiveIsSystem = target.isSystem;
      } else if (systemRoleNameSet.has(role.name)) {
        if (!role.isSystem) {
          errors.push(
            `role "${role.name}" is a reserved system role name — the envelope must mark it isSystem: true`,
          );
          continue;
        }
        effectiveIsSystem = true;
      } else {
        if (role.isSystem) {
          errors.push(
            `role "${role.name}" claims isSystem but is neither a system role in the target nor a recognised system role name — refused, not honored`,
          );
          continue;
        }
        effectiveIsSystem = false;
      }

      if (target?.archivedAt != null) {
        errors.push(
          `role "${role.name}" is archived in the target — archived roles are read-only; unarchive is not supported`,
        );
        continue;
      }

      const unknown = role.permissions.filter((p) => !knownPermissionKeys.has(p));
      if (unknown.length > 0) {
        errors.push(`role "${role.name}" references unknown permission(s): ${unknown.join(', ')}`);
        continue;
      }

      const targetPerms =
        target === undefined
          ? []
          : target.rolePermissions.map((rp) => formatPermission(rp.permission)).sort();
      const filePerms = [...role.permissions].sort();
      const targetPermSet = new Set(targetPerms);
      const filePermSet = new Set(filePerms);
      const permissionsToAttach = filePerms.filter((p) => !targetPermSet.has(p));
      const permissionsToDetach = targetPerms.filter((p) => !filePermSet.has(p));
      const descriptionChange =
        target !== undefined && target.description !== role.description
          ? { from: target.description, to: role.description }
          : null;

      const changed =
        target === undefined ||
        permissionsToAttach.length > 0 ||
        permissionsToDetach.length > 0 ||
        descriptionChange !== null;

      if (!changed) {
        unchangedRoles.push(role.name);
        continue;
      }

      if (effectiveIsSystem) systemRoleChanges.push(role.name);
      roleDiffs.push({
        name: role.name,
        kind: target === undefined ? 'create' : 'update',
        isSystem: effectiveIsSystem,
        sensitive: sensitiveRoleNameSet.has(role.name),
        descriptionChange,
        permissionsToAttach,
        permissionsToDetach,
      });
    }

    const envelopeRoleNames = new Set(envelope.roles.map((r) => r.name));
    const envelopePermKeys = new Set(envelope.permissions.map((p) => `${p.resource}:${p.action}`));
    const warnings: string[] = [];
    for (const r of targetRoles) {
      if (!envelopeRoleNames.has(r.name) && r.archivedAt === null) {
        warnings.push(
          `target role "${r.name}" is absent from the envelope — left untouched (import never deletes)`,
        );
      }
    }
    for (const key of targetPermByKey.keys()) {
      if (!envelopePermKeys.has(key)) {
        warnings.push(
          `target permission "${key}" is absent from the envelope — left untouched (import never deletes)`,
        );
      }
    }

    return {
      permissionsToCreate,
      permissionDescriptionUpdates,
      roleDiffs,
      unchangedRoles,
      warnings,
      systemRoleChanges,
      errors,
    };
  }

  /**
   * Validate, guard, and apply an import in one transaction, emitting
   * one `audit.action_recorded` per CHANGED role. Throws
   * {@link RbacCatalogImportValidationError} (bad envelope semantics)
   * or {@link RbacCatalogImportRefusedError} (system/sensitive-role
   * changes without `allowSystem`) before any write.
   */
  async applyImport(
    envelope: RbacCatalogEnvelope,
    options: { readonly allowSystem: boolean; readonly actor: AuditActor },
  ): Promise<RbacCatalogImportResult> {
    const plan = await this.planImport(envelope);
    if (plan.errors.length > 0) {
      throw new RbacCatalogImportValidationError(plan.errors);
    }
    if (plan.systemRoleChanges.length > 0 && !options.allowSystem) {
      throw new RbacCatalogImportRefusedError(plan.systemRoleChanges);
    }

    const hasWork =
      plan.permissionsToCreate.length > 0 ||
      plan.permissionDescriptionUpdates.length > 0 ||
      plan.roleDiffs.length > 0;
    if (!hasWork) {
      this.logger.log({ warnings: plan.warnings.length }, 'rbac catalog import: no changes');
      return { applied: false, plan, report: null, auditedRoles: [] };
    }

    // Normalize the envelope onto the apply input with the EFFECTIVE
    // isSystem per role (target-authoritative — plan already rejected
    // bogus claims). Only changed roles are passed so the apply's
    // upserts (and description refreshes) never touch unchanged rows.
    const changedNames = new Set(plan.roleDiffs.map((d) => d.name));
    const systemNameSet = new Set<string>(SYSTEM_ROLE_NAMES);
    const input: RbacCatalogInput = {
      permissions: envelope.permissions.map((p) => ({
        resource: p.resource,
        action: p.action,
        description: p.description,
      })),
      roles: envelope.roles
        .filter((r) => changedNames.has(r.name))
        .map((r) => {
          const diff = plan.roleDiffs.find((d) => d.name === r.name);
          return {
            name: r.name,
            description: r.description,
            permissions: r.permissions,
            isSystem: diff?.isSystem ?? (systemNameSet.has(r.name) ? r.isSystem : false),
          };
        }),
    };

    const applied = await this.prisma.$transaction(
      async (tx: RbacSeedClient & OutboxRawExecutor) => {
        const result = await applyRbacCatalog(tx, input, {
          unknownPermissionMode: 'reject',
          resolveAgainstExisting: true,
        });
        const audited: string[] = [];
        for (const change of result.roleChanges) {
          if (change.kind === 'unchanged') continue;
          await this.audit.emit(tx, options.actor, {
            action: change.kind === 'created' ? 'rbac_role:create' : 'rbac_role:update',
            resourceKind: RBAC_AUDIT_RESOURCE.role,
            resourceId: change.roleId,
            before: change.before,
            after: { ...change.after, importedVia: 'rbac:catalog import' },
          });
          audited.push(change.name);
        }
        return { result, audited };
      },
    );

    this.logger.log(
      {
        rolesChanged: applied.audited.length,
        permissionsCreated: applied.result.permissionsCreated.length,
        attached: applied.result.report.rolePermissionsAttached,
        detached: applied.result.report.rolePermissionsDetached,
        allowSystem: options.allowSystem,
        actorUserId: options.actor.actorUserId,
      },
      'rbac catalog import applied',
    );

    return {
      applied: true,
      plan,
      report: applied.result.report,
      auditedRoles: applied.audited,
    };
  }
}

/**
 * Structural read-row types — explicit annotations because the
 * extended Prisma client's inference collapses nested selects under
 * this tsconfig's strictness (same workaround as `RoleCatalogTxClient`
 * / `RbacSeedClient`).
 */
interface TargetPermissionRow {
  readonly resource: string;
  readonly action: string;
  readonly description: string | null;
}

interface TargetRoleRow {
  readonly name: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly archivedAt: Date | null;
  readonly rolePermissions: ReadonlyArray<{
    readonly permission: { readonly resource: string; readonly action: string };
  }>;
}

/** One role's would-be change in an import plan. */
export interface RbacCatalogRoleDiff {
  readonly name: string;
  readonly kind: 'create' | 'update';
  /** EFFECTIVE flag — target-authoritative, never the file's claim. */
  readonly isSystem: boolean;
  /** Member of `SENSITIVE_ROLE_NAMES` (`super_admin`, `finance`). */
  readonly sensitive: boolean;
  readonly descriptionChange: { readonly from: string | null; readonly to: string | null } | null;
  readonly permissionsToAttach: readonly string[];
  readonly permissionsToDetach: readonly string[];
}

/** The read-only import plan — the dry-run output. */
export interface RbacCatalogImportPlan {
  readonly permissionsToCreate: readonly string[];
  readonly permissionDescriptionUpdates: readonly string[];
  readonly roleDiffs: readonly RbacCatalogRoleDiff[];
  readonly unchangedRoles: readonly string[];
  /** Target rows the envelope omits — reported, NEVER deleted. */
  readonly warnings: readonly string[];
  /** Changed roles that are system roles — the guardrail input. */
  readonly systemRoleChanges: readonly string[];
  readonly errors: readonly string[];
}

export interface RbacCatalogImportResult {
  readonly applied: boolean;
  readonly plan: RbacCatalogImportPlan;
  readonly report: RbacSeedReport | null;
  readonly auditedRoles: readonly string[];
}

/** Envelope semantics failed validation (unknown perms, bogus isSystem, archived targets). */
export class RbacCatalogImportValidationError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`rbac catalog import failed validation:\n  - ${errors.join('\n  - ')}`);
    this.name = 'RbacCatalogImportValidationError';
  }
}

/** System/sensitive-role changes present without the explicit allow flag. */
export class RbacCatalogImportRefusedError extends Error {
  constructor(readonly systemRoleChanges: readonly string[]) {
    super(
      `rbac catalog import refused: it would alter system role(s) [${systemRoleChanges.join(', ')}] — re-run with --allow-system if this is intentional`,
    );
    this.name = 'RbacCatalogImportRefusedError';
  }
}
