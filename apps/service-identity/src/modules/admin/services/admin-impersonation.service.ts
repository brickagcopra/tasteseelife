import { Inject, Injectable, Logger } from '@nestjs/common';
import { isAdminRoleName } from '@taste-and-see/auth-sdk';
import { type Counter, getMeter } from '@taste-and-see/tracing';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthService } from '../../auth/services/auth.service';
import { RoleAssignmentService } from '../../rbac/role-assignment.service';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { RBAC_AUDIT_RESOURCE } from '../../rbac/audit-resources';

const METER_NAME = 'service-identity:impersonation';

/**
 * Admin impersonation for support diagnostics (TS-297; PRD §10.2;
 * CLAUDE.md §3.6).
 *
 * `start` mints a session IN THE TARGET USER'S NAME: the access token's
 * `sub` is the target (so downstream authorisation acts exactly as the
 * user would), the `actorOnBehalfOf` claim and the refresh rows'
 * `impersonator_user_id` both carry the OPERATOR, and the refresh
 * family is capped at `IMPERSONATION_SESSION_TTL_SECONDS` (default 1h)
 * instead of the ordinary 30-day TTL. The session insert and the
 * `user_impersonation:start` audit event commit in ONE transaction —
 * an impersonation that cannot be audited never exists (CLAUDE.md
 * §3.6; same invariant as every RBAC mutation since TS-295).
 *
 * Refusal rules (all warn-logged; wire layer maps to 403/404/409):
 *   - `self` — impersonating yourself is always operator error.
 *   - `admin_target` — the target holds an active admin-staff role.
 *     Impersonating staff would let an operator act under a
 *     colleague's identity (privilege laundering) and would also drag
 *     the TS-296 SSO gate into a session the IdP never asserted.
 *   - `deactivated` — permanently-closed accounts stay closed.
 *   - SUSPENDED targets are ALLOWED: support routinely diagnoses the
 *     account state that led to the suspension. The audit event and
 *     an explicit warn log record the target's status.
 *
 * Because admin-staff targets are refused, the TS-296 SSO gate inside
 * `issueSessionFor` never fires on an impersonation mint — the target
 * holds no admin-staff assignment, so the gate's scope set is empty.
 * The operator's OWN login already satisfied their org's policy.
 *
 * `end` revokes the family (idempotent) and emits
 * `user_impersonation:end` atomically with the revocation — but only
 * when this call actually revoked something, so replays don't spam
 * the trail.
 *
 * `mfaVerified` on the minted session is inherited from the OPERATOR's
 * verified context: the human at the keyboard cleared MFA; the target
 * user never authenticated at all.
 */
@Injectable()
export class AdminImpersonationService {
  private readonly logger = new Logger(AdminImpersonationService.name);
  private readonly started: Counter;
  private readonly ended: Counter;
  private readonly refused: Counter;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly roleAssignments: RoleAssignmentService,
    private readonly audit: AuditEmitter,
    // Narrowed to the one knob this service reads so unit tests can
    // pass a one-field object instead of a full Env fixture. DI still
    // provides the full Env (which satisfies the Pick).
    @Inject(ENV_TOKEN) private readonly env: Pick<Env, 'IMPERSONATION_SESSION_TTL_SECONDS'>,
  ) {
    const meter = getMeter(METER_NAME);
    this.started = meter.createCounter('impersonation_sessions_started_total', {
      description: 'Total impersonation sessions minted.',
    });
    this.ended = meter.createCounter('impersonation_sessions_ended_total', {
      description: 'Total impersonation sessions explicitly ended.',
    });
    this.refused = meter.createCounter('impersonation_refusals_total', {
      description: 'Total refused impersonation attempts, by reason.',
    });
  }

  async start(input: {
    readonly targetUserId: string;
    readonly reason: string;
    readonly actor: AuditActorContext;
    readonly operatorMfaVerified: boolean;
  }): Promise<ImpersonationStartResult> {
    const target = await this.prisma.user.findFirst({
      where: { id: input.targetUserId, deletedAt: null },
      select: { id: true, email: true, status: true },
    });
    if (target === null) {
      return { ok: false, failure: { kind: 'target_not_found' } };
    }

    const refusal = await this.refusalFor(target, input.actor.actorUserId);
    if (refusal !== null) {
      this.refused.add(1, { reason: refusal });
      this.logger.warn(
        {
          operatorUserId: input.actor.actorUserId,
          targetUserId: target.id,
          reason: refusal,
        },
        'impersonation refused',
      );
      return { ok: false, failure: { kind: refusal } };
    }

    if (target.status === 'suspended') {
      // Allowed by design (support diagnoses suspended accounts) but
      // loud: a suspended-account impersonation is worth an ops glance.
      this.logger.warn(
        { operatorUserId: input.actor.actorUserId, targetUserId: target.id },
        'impersonating a suspended account',
      );
    }

    const sessionExpiresAt = new Date(
      Date.now() + this.env.IMPERSONATION_SESSION_TTL_SECONDS * 1000,
    );

    type TxClient = { refreshToken: PrismaService['refreshToken'] } & OutboxRawExecutor;
    const minted = await this.prisma.$transaction(async (tx: TxClient) => {
      const session = await this.auth.issueSessionFor({
        userId: target.id,
        email: target.email,
        status: target.status,
        mfaVerified: input.operatorMfaVerified,
        ssoAsserted: false,
        ...(input.actor.ip !== null ? { ip: input.actor.ip } : {}),
        ...(input.actor.userAgent !== null ? { userAgent: input.actor.userAgent } : {}),
        impersonation: {
          operatorUserId: input.actor.actorUserId,
          sessionExpiresAt,
          tx,
        },
      });
      await this.audit.emit(tx, input.actor, {
        action: 'user_impersonation:start',
        resourceKind: RBAC_AUDIT_RESOURCE.userImpersonation,
        resourceId: target.id,
        before: null,
        after: {
          operatorUserId: input.actor.actorUserId,
          impersonatedUserId: target.id,
          sessionFamilyId: session.sessionFamilyId,
          sessionExpiresAt: sessionExpiresAt.toISOString(),
          targetStatus: target.status,
          reason: input.reason,
        },
      });
      return session;
    });

    this.started.add(1);
    // Token values are secrets — log ONLY the family id (CLAUDE.md §3.9).
    this.logger.log(
      {
        operatorUserId: input.actor.actorUserId,
        targetUserId: target.id,
        sessionFamilyId: minted.sessionFamilyId,
        sessionExpiresAt: sessionExpiresAt.toISOString(),
      },
      'impersonation session started',
    );

    return {
      ok: true,
      value: {
        accessToken: minted.response.accessToken,
        expiresIn: minted.response.expiresIn,
        refreshToken: minted.refreshToken,
        sessionFamilyId: minted.sessionFamilyId,
        sessionExpiresAt,
        operatorUserId: input.actor.actorUserId,
        user: { id: target.id, email: target.email, status: target.status },
      },
    };
  }

  async end(input: {
    readonly sessionFamilyId: string;
    readonly actor: AuditActorContext;
  }): Promise<ImpersonationEndResult> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { familyId: input.sessionFamilyId },
      select: { userId: true, impersonatorUserId: true },
    });
    if (row === null) {
      return { ok: false, failure: { kind: 'family_not_found' } };
    }
    if (row.impersonatorUserId === null) {
      // Refusing to revoke ORDINARY sessions through this surface keeps
      // it single-purpose; "kill any session" is the TS-126 session-
      // management surface, with its own audit story.
      this.refused.add(1, { reason: 'not_impersonation' });
      this.logger.warn(
        { actorUserId: input.actor.actorUserId, sessionFamilyId: input.sessionFamilyId },
        'end-impersonation refused — family is not an impersonation session',
      );
      return { ok: false, failure: { kind: 'not_impersonation' } };
    }

    const endedAt = new Date();
    type TxClient = { refreshToken: PrismaService['refreshToken'] } & OutboxRawExecutor;
    const revokedCount = await this.prisma.$transaction(async (tx: TxClient) => {
      const result = await tx.refreshToken.updateMany({
        where: { familyId: input.sessionFamilyId, revokedAt: null },
        data: { revokedAt: endedAt },
      });
      if (result.count > 0) {
        await this.audit.emit(tx, input.actor, {
          action: 'user_impersonation:end',
          resourceKind: RBAC_AUDIT_RESOURCE.userImpersonation,
          resourceId: row.userId,
          before: {
            operatorUserId: row.impersonatorUserId,
            impersonatedUserId: row.userId,
            sessionFamilyId: input.sessionFamilyId,
            active: true,
          },
          after: {
            operatorUserId: row.impersonatorUserId,
            impersonatedUserId: row.userId,
            sessionFamilyId: input.sessionFamilyId,
            active: false,
            endedAt: endedAt.toISOString(),
          },
        });
      }
      return result.count;
    });

    if (revokedCount > 0) {
      this.ended.add(1);
      this.logger.log(
        {
          actorUserId: input.actor.actorUserId,
          sessionFamilyId: input.sessionFamilyId,
          revokedCount,
        },
        'impersonation session ended',
      );
    }

    return {
      ok: true,
      value: { sessionFamilyId: input.sessionFamilyId, ended: revokedCount > 0, endedAt },
    };
  }

  /** First refusal rule the (existing, non-deleted) target trips, or null. */
  private async refusalFor(
    target: { readonly id: string; readonly status: string },
    operatorUserId: string,
  ): Promise<'self' | 'admin_target' | 'deactivated' | null> {
    if (target.id === operatorUserId) return 'self';
    if (target.status === 'deactivated') return 'deactivated';
    const targetRoles = await this.roleAssignments.getActiveAssignments(target.id);
    if (targetRoles.some((role) => isAdminRoleName(role.name))) return 'admin_target';
    return null;
  }
}

export type ImpersonationStartResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly accessToken: string;
        readonly expiresIn: number;
        readonly refreshToken: string;
        readonly sessionFamilyId: string;
        readonly sessionExpiresAt: Date;
        readonly operatorUserId: string;
        readonly user: {
          readonly id: string;
          readonly email: string;
          readonly status: 'pending_verification' | 'active' | 'suspended' | 'deactivated';
        };
      };
    }
  | {
      readonly ok: false;
      readonly failure: {
        readonly kind: 'target_not_found' | 'self' | 'admin_target' | 'deactivated';
      };
    };

export type ImpersonationEndResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly sessionFamilyId: string;
        readonly ended: boolean;
        readonly endedAt: Date;
      };
    }
  | {
      readonly ok: false;
      readonly failure: { readonly kind: 'family_not_found' | 'not_impersonation' };
    };
