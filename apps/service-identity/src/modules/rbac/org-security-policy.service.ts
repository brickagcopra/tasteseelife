import { Injectable, Logger } from '@nestjs/common';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService } from '../../prisma/prisma.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { RBAC_AUDIT_RESOURCE } from './audit-resources';

/**
 * Narrow structural type for the interactive-transaction client —
 * only the surface the upsert touches. Same convention as
 * `RoleCatalogTxClient` (annotating the callback param keeps the
 * extended client's `$transaction` overloads from collapsing the
 * param to `any` under this tsconfig's strictness).
 */
interface OrgSecurityPolicyTxClient {
  readonly orgSecurityPolicy: {
    create(req: {
      data: { scopeId: string; ssoRequired: boolean };
      select: typeof SELECT_FOR_POLICY;
    }): Promise<PolicySelect>;
    update(req: {
      where: { scopeId: string };
      data: { ssoRequired: boolean };
      select: typeof SELECT_FOR_POLICY;
    }): Promise<PolicySelect>;
  };
}

const SELECT_FOR_POLICY = {
  id: true,
  scopeId: true,
  ssoRequired: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface PolicySelect {
  readonly id: string;
  readonly scopeId: string;
  readonly ssoRequired: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One policy row as projected for the admin surface. */
export interface OrgSecurityPolicyRow {
  readonly id: string;
  readonly scopeId: string;
  readonly ssoRequired: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertOrgSecurityPolicyInput {
  readonly scopeId: string;
  readonly ssoRequired: boolean;
  readonly actor: AuditActorContext;
}

/** The audit before/after snapshot — wire-DTO-shaped, never a raw row. */
function policyAuditSnapshot(row: OrgSecurityPolicyRow): {
  readonly scopeId: string;
  readonly ssoRequired: boolean;
} {
  return { scopeId: row.scopeId, ssoRequired: row.ssoRequired };
}

/**
 * Org security policies (TS-296; CLAUDE.md §3.1; PDD §10.1) —
 * security flags keyed by tenant scope id (or the `'global'`
 * sentinel), starting with `ssoRequired`.
 *
 * Two consumers:
 *
 *   - The admin surface (`AdminOrgSecurityPoliciesController`):
 *     `listPolicies` + `upsertPolicy`. The upsert emits
 *     `audit.action_recorded` (`org_security_policy:create|update`)
 *     in-tx via `AuditEmitter` — this table configures who can
 *     obtain an admin session, so its mutations are audit-critical
 *     (TS-295 invariant: an unauditable mutation never commits).
 *
 *   - The login gate (`AuthService.issueSessionFor`):
 *     `ssoRequiredForScopes` — one indexed lookup over the caller's
 *     admin-assignment scope ids, paid only when the user holds an
 *     admin role. Absent rows mean "no policy" (default-off), so a
 *     fresh deployment changes nothing until an operator opts a
 *     scope in.
 */
@Injectable()
export class OrgSecurityPolicyService {
  private readonly logger = new Logger(OrgSecurityPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEmitter,
  ) {}

  /** Every policy row, stable order for the admin table. */
  async listPolicies(): Promise<readonly OrgSecurityPolicyRow[]> {
    return this.prisma.orgSecurityPolicy.findMany({
      select: SELECT_FOR_POLICY,
      orderBy: { scopeId: 'asc' },
    });
  }

  /**
   * `true` when ANY of `scopeIds` has a policy row with
   * `ssoRequired: true`. Empty input short-circuits to `false`
   * without touching the database (the common non-admin path never
   * reaches here at all — the caller skips the check when the user
   * holds no admin role).
   */
  async ssoRequiredForScopes(scopeIds: readonly string[]): Promise<boolean> {
    if (scopeIds.length === 0) return false;
    const count = await this.prisma.orgSecurityPolicy.count({
      where: { scopeId: { in: [...scopeIds] }, ssoRequired: true },
    });
    return count > 0;
  }

  /**
   * Create-or-update the policy row for `scopeId` (PUT semantics —
   * absent row means default-off, so create and update are the same
   * operator gesture). A no-op upsert (row already in the requested
   * state) returns the existing row WITHOUT emitting an audit event —
   * replays converge silently instead of spamming the trail.
   */
  async upsertPolicy(input: UpsertOrgSecurityPolicyInput): Promise<OrgSecurityPolicyRow> {
    const existing = await this.prisma.orgSecurityPolicy.findUnique({
      where: { scopeId: input.scopeId },
      select: SELECT_FOR_POLICY,
    });

    if (existing !== null && existing.ssoRequired === input.ssoRequired) {
      return existing;
    }

    const action = existing === null ? 'org_security_policy:create' : 'org_security_policy:update';
    const row = await this.prisma.$transaction(
      async (tx: OrgSecurityPolicyTxClient & OutboxRawExecutor) => {
        const written =
          existing === null
            ? await tx.orgSecurityPolicy.create({
                data: { scopeId: input.scopeId, ssoRequired: input.ssoRequired },
                select: SELECT_FOR_POLICY,
              })
            : await tx.orgSecurityPolicy.update({
                where: { scopeId: input.scopeId },
                data: { ssoRequired: input.ssoRequired },
                select: SELECT_FOR_POLICY,
              });
        await this.audit.emit(tx, input.actor, {
          action,
          resourceKind: RBAC_AUDIT_RESOURCE.orgSecurityPolicy,
          resourceId: written.id,
          before: existing === null ? null : policyAuditSnapshot(existing),
          after: policyAuditSnapshot(written),
        });
        return written;
      },
    );

    this.logger.log(
      {
        action,
        actorId: input.actor.actorUserId,
        scopeId: row.scopeId,
        ssoRequired: row.ssoRequired,
      },
      'org security policy upserted',
    );
    return row;
  }
}
