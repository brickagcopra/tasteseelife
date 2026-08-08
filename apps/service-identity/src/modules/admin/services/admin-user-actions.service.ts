import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import type { AdminUserListRow } from './admin-users.service';

/**
 * Local enum mirrors. Same TS-021-followup-2 / -3 / TS-026-followup-5
 * root cause documented across the codebase — Prisma 5.22's namespace
 * value-side resolves inconsistently under our tsconfig, so services
 * use locally-declared string-literal unions for the generated enums.
 * Kept in lockstep with the contract-side `UserStatusSchema` enum and
 * the existing mirror in `admin-users.service.ts`.
 */
type UserStatusValue = 'pending_verification' | 'active' | 'suspended' | 'deactivated';

/**
 * Snapshot of the user-row state the three actions actually touch.
 * Returned by `runAction` so callers can compute the before / after
 * diff without an extra DB read.
 */
export interface AdminUserActionStateRow {
  readonly status: UserStatusValue;
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: Date | null;
  readonly lockedUntil: Date | null;
}

/**
 * Result of a successful action. Carries the before / after row
 * snapshots and a fresh denormalised `AdminUserListRow` so the
 * controller can return the same row shape the list endpoint uses
 * (the web-admin UI re-renders the row in-place after the action).
 */
export interface AdminUserActionSuccess {
  readonly userId: string;
  readonly before: AdminUserActionStateRow;
  readonly after: AdminUserActionStateRow;
  readonly user: AdminUserListRow;
  readonly performedAt: Date;
}

/**
 * Failure variants — Result-shape per CLAUDE.md §2.1. The service does
 * NOT throw HttpExceptions; the controller maps these into RFC 7807
 * problem details (404 for `user_not_found`, 409 for
 * `illegal_transition`) so the service stays HTTP-agnostic and easy to
 * unit-test.
 *
 *   - `user_not_found` — id does not resolve, OR row is soft-deleted.
 *     Soft-deleted accounts are off-limits for admin mutation; if ops
 *     needs to take action they restore first (a future capability).
 *
 *   - `illegal_transition` — current status doesn't permit the
 *     requested transition. Suspend requires `active`; reinstate
 *     requires `suspended`. Unlock never trips this — it's a no-op on
 *     an already-clear account (still a success).
 */
export type AdminUserActionFailure =
  | { readonly kind: 'user_not_found' }
  | {
      readonly kind: 'illegal_transition';
      readonly currentStatus: UserStatusValue;
      readonly attempted: 'suspend' | 'reinstate';
    };

export type AdminUserActionResult =
  | { readonly ok: true; readonly value: AdminUserActionSuccess }
  | { readonly ok: false; readonly failure: AdminUserActionFailure };

export interface PerformActionInput {
  readonly userId: string;
  readonly actorUserId: string;
  readonly now?: Date | undefined;
}

/**
 * Lockout columns the service touches on `unlock`. Used by the
 * controller-level test stubs as a typed shape; the service produces
 * this via Prisma row reads.
 */
interface UserRowWithLockout {
  readonly id: string;
  readonly status: UserStatusValue;
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: Date | null;
  readonly lockedUntil: Date | null;
  readonly deletedAt: Date | null;
}

/**
 * Roles map shape used to denormalise `activeRoleCount` +
 * `holdsAdminRole` on the returned `AdminUserListRow`. We re-use the
 * same lookup the read-side admin service uses so the post-action
 * card stays consistent with what the list endpoint would return.
 */
const ADMIN_ROLE_LOOKUP: ReadonlySet<string> = new Set([
  'super_admin',
  'operations_manager',
  'customer_support',
  'concierge_lead',
  'provider_ops',
  'finance',
  'marketing',
  'content_editor',
  'trust_safety',
  'read_only_auditor',
]);

/**
 * Admin user mutations service (TS-126-followup-1; PRD §10.2;
 * closes TS-025-followup-2).
 *
 * Owns three operations on the `users` row:
 *
 *   - `suspend`   — flip `status` `active → suspended`.
 *   - `reinstate` — flip `status` `suspended → active`.
 *   - `unlock`    — clear `lockedUntil`, `failedLoginCount`,
 *                   `lastFailedLoginAt`. No status mutation.
 *
 * All three run inside a single `$transaction` that reads the
 * current row, asserts the transition is legal, writes the new
 * state, and projects the resulting row onto an `AdminUserListRow`
 * (with role denormalisation) so the controller can return the same
 * shape the list endpoint emits.
 *
 * **Audit pipe.** Slice 1 emits structured `logger.log` lines on
 * every mutation as a forward-compat scaffold; the real
 * `service-audit` outbox event lands with TS-126-followup-5 once
 * TS-100 audit-svc is up. The CLAUDE.md §3.6 contract says every
 * admin mutation must produce an audit event with actor / action /
 * resource / before / after — the log lines carry that data
 * verbatim so when we wire the outbox, the data shape is already
 * stable.
 *
 * **Authorisation.** The controller layer enforces
 * `AccessTokenGuard` → `SuperAdminRoleGuard`. This service does NOT
 * re-check authority — it trusts the controller to have done so.
 *
 * **Idempotency.** The controller wraps each endpoint with
 * `@Idempotent()` so a retried admin click replays the cached
 * response. At the service layer, `unlock` is naturally idempotent
 * (calling on an already-clear account is a no-op success);
 * `suspend` and `reinstate` are NOT naturally idempotent — a second
 * call after the first commits would land an `illegal_transition`.
 * The interceptor's body+key cache catches the typical retry case;
 * the explicit `illegal_transition` is the right error when ops
 * issues two distinct actions back-to-back without realising the
 * first already landed.
 */
@Injectable()
export class AdminUserActionsService {
  private readonly logger = new Logger(AdminUserActionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async suspend(
    input: PerformActionInput & { readonly reason: string; readonly note: string | null },
  ): Promise<AdminUserActionResult> {
    return this.runStatusTransition({
      input,
      attempted: 'suspend',
      requiredCurrentStatus: 'active',
      nextStatus: 'suspended',
      auditAction: 'admin.users.suspend',
      reason: input.reason,
      note: input.note,
    });
  }

  async reinstate(
    input: PerformActionInput & { readonly reason: string; readonly note: string | null },
  ): Promise<AdminUserActionResult> {
    return this.runStatusTransition({
      input,
      attempted: 'reinstate',
      requiredCurrentStatus: 'suspended',
      nextStatus: 'active',
      auditAction: 'admin.users.reinstate',
      reason: input.reason,
      note: input.note,
    });
  }

  async unlock(
    input: PerformActionInput & { readonly note: string | null },
  ): Promise<AdminUserActionResult> {
    const now = input.now ?? new Date();

    type TxClient = {
      user: PrismaService['user'];
      userRole: PrismaService['userRole'];
    };

    const updated = await this.prisma.$transaction(async (tx: TxClient) => {
      const row = (await tx.user.findUnique({
        where: { id: input.userId },
        select: {
          id: true,
          status: true,
          failedLoginCount: true,
          lastFailedLoginAt: true,
          lockedUntil: true,
          deletedAt: true,
        },
      })) as UserRowWithLockout | null;

      if (row === null || row.deletedAt !== null) {
        return { kind: 'not_found' as const };
      }

      const before: AdminUserActionStateRow = {
        status: row.status,
        failedLoginCount: row.failedLoginCount,
        lastFailedLoginAt: row.lastFailedLoginAt,
        lockedUntil: row.lockedUntil,
      };

      // Unlock is naturally idempotent — the write reduces to "set
      // these three columns to their cleared values" regardless of
      // current state. Even when every column is already clear, we
      // still write so the audit log records the action (the
      // observable behaviour matches "ops asked to unlock the
      // account", not "ops asked AND the column had a value").
      const updatedRow = (await tx.user.update({
        where: { id: input.userId },
        data: {
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          mfaEnabled: true,
          emailVerifiedAt: true,
          failedLoginCount: true,
          lastFailedLoginAt: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      })) as {
        readonly id: string;
        readonly email: string;
        readonly phone: string | null;
        readonly status: UserStatusValue;
        readonly mfaEnabled: boolean;
        readonly emailVerifiedAt: Date | null;
        readonly failedLoginCount: number;
        readonly lastFailedLoginAt: Date | null;
        readonly lockedUntil: Date | null;
        readonly createdAt: Date;
        readonly updatedAt: Date;
      };

      const summary = await this.fetchRoleSummary(tx, input.userId, now);

      const after: AdminUserActionStateRow = {
        status: updatedRow.status,
        failedLoginCount: updatedRow.failedLoginCount,
        lastFailedLoginAt: updatedRow.lastFailedLoginAt,
        lockedUntil: updatedRow.lockedUntil,
      };

      const user: AdminUserListRow = {
        id: updatedRow.id,
        email: updatedRow.email,
        phone: updatedRow.phone,
        status: updatedRow.status,
        mfaEnabled: updatedRow.mfaEnabled,
        emailVerifiedAt: updatedRow.emailVerifiedAt,
        activeRoleCount: summary.activeRoleCount,
        holdsAdminRole: summary.holdsAdminRole,
        currentlyLocked: false,
        createdAt: updatedRow.createdAt,
        updatedAt: updatedRow.updatedAt,
      };

      return { kind: 'ok' as const, before, after, user, performedAt: now };
    });

    if (updated.kind === 'not_found') {
      return { ok: false, failure: { kind: 'user_not_found' } };
    }

    this.logger.log(
      {
        actorId: input.actorUserId,
        action: 'admin.users.unlock',
        targetUserId: input.userId,
        before: snapshotForLog(updated.before),
        after: snapshotForLog(updated.after),
        note: input.note,
      },
      'admin user action',
    );

    return {
      ok: true,
      value: {
        userId: input.userId,
        before: updated.before,
        after: updated.after,
        user: updated.user,
        performedAt: updated.performedAt,
      },
    };
  }

  /**
   * Shared core for suspend / reinstate — both follow the same
   * read-current-row → assert-allowed-transition → write-new-status →
   * project shape. Pulled out into one method because the only deltas
   * between the two are the precondition status, the next status,
   * and the audit-action string.
   */
  private async runStatusTransition(args: {
    readonly input: PerformActionInput & { readonly reason: string; readonly note: string | null };
    readonly attempted: 'suspend' | 'reinstate';
    readonly requiredCurrentStatus: UserStatusValue;
    readonly nextStatus: UserStatusValue;
    readonly auditAction: string;
    readonly reason: string;
    readonly note: string | null;
  }): Promise<AdminUserActionResult> {
    const now = args.input.now ?? new Date();

    type TxClient = {
      user: PrismaService['user'];
      userRole: PrismaService['userRole'];
    };

    const outcome = await this.prisma.$transaction(async (tx: TxClient) => {
      const row = (await tx.user.findUnique({
        where: { id: args.input.userId },
        select: {
          id: true,
          status: true,
          failedLoginCount: true,
          lastFailedLoginAt: true,
          lockedUntil: true,
          deletedAt: true,
        },
      })) as UserRowWithLockout | null;

      if (row === null || row.deletedAt !== null) {
        return { kind: 'not_found' as const };
      }

      if (row.status !== args.requiredCurrentStatus) {
        return {
          kind: 'illegal' as const,
          currentStatus: row.status,
        };
      }

      const before: AdminUserActionStateRow = {
        status: row.status,
        failedLoginCount: row.failedLoginCount,
        lastFailedLoginAt: row.lastFailedLoginAt,
        lockedUntil: row.lockedUntil,
      };

      const updatedRow = (await tx.user.update({
        where: { id: args.input.userId },
        data: {
          status: args.nextStatus,
        },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          mfaEnabled: true,
          emailVerifiedAt: true,
          failedLoginCount: true,
          lastFailedLoginAt: true,
          lockedUntil: true,
          createdAt: true,
          updatedAt: true,
        },
      })) as {
        readonly id: string;
        readonly email: string;
        readonly phone: string | null;
        readonly status: UserStatusValue;
        readonly mfaEnabled: boolean;
        readonly emailVerifiedAt: Date | null;
        readonly failedLoginCount: number;
        readonly lastFailedLoginAt: Date | null;
        readonly lockedUntil: Date | null;
        readonly createdAt: Date;
        readonly updatedAt: Date;
      };

      const summary = await this.fetchRoleSummary(tx, args.input.userId, now);

      const after: AdminUserActionStateRow = {
        status: updatedRow.status,
        failedLoginCount: updatedRow.failedLoginCount,
        lastFailedLoginAt: updatedRow.lastFailedLoginAt,
        lockedUntil: updatedRow.lockedUntil,
      };

      const user: AdminUserListRow = {
        id: updatedRow.id,
        email: updatedRow.email,
        phone: updatedRow.phone,
        status: updatedRow.status,
        mfaEnabled: updatedRow.mfaEnabled,
        emailVerifiedAt: updatedRow.emailVerifiedAt,
        activeRoleCount: summary.activeRoleCount,
        holdsAdminRole: summary.holdsAdminRole,
        currentlyLocked: isCurrentlyLocked(updatedRow.lockedUntil, now),
        createdAt: updatedRow.createdAt,
        updatedAt: updatedRow.updatedAt,
      };

      return { kind: 'ok' as const, before, after, user, performedAt: now };
    });

    if (outcome.kind === 'not_found') {
      return { ok: false, failure: { kind: 'user_not_found' } };
    }
    if (outcome.kind === 'illegal') {
      return {
        ok: false,
        failure: {
          kind: 'illegal_transition',
          currentStatus: outcome.currentStatus,
          attempted: args.attempted,
        },
      };
    }

    this.logger.log(
      {
        actorId: args.input.actorUserId,
        action: args.auditAction,
        targetUserId: args.input.userId,
        before: snapshotForLog(outcome.before),
        after: snapshotForLog(outcome.after),
        reason: args.reason,
        note: args.note,
      },
      'admin user action',
    );

    return {
      ok: true,
      value: {
        userId: args.input.userId,
        before: outcome.before,
        after: outcome.after,
        user: outcome.user,
        performedAt: outcome.performedAt,
      },
    };
  }

  /**
   * One-row role summary used to denormalise the returned
   * `AdminUserListRow`. Lives inside the transaction so the role-
   * count we report matches the row state we just wrote (Postgres
   * REPEATABLE READ inside the explicit `$transaction`).
   */
  private async fetchRoleSummary(
    tx: { userRole: PrismaService['userRole'] },
    userId: string,
    now: Date,
  ): Promise<{ activeRoleCount: number; holdsAdminRole: boolean }> {
    const rows = (await tx.userRole.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { role: { select: { name: true } } },
    })) as ReadonlyArray<{ readonly role: { readonly name: string } }>;

    let holdsAdminRole = false;
    for (const r of rows) {
      if (ADMIN_ROLE_LOOKUP.has(r.role.name)) {
        holdsAdminRole = true;
        break;
      }
    }

    return { activeRoleCount: rows.length, holdsAdminRole };
  }
}

function isCurrentlyLocked(lockedUntil: Date | null, now: Date): boolean {
  if (lockedUntil === null) return false;
  return lockedUntil.getTime() > now.getTime();
}

/**
 * Convert a Date column to ISO inside the structured log payload so
 * the audit pipe (TS-126-followup-5) receives the same shape the
 * audit-event schema (TS-100) eventually validates against.
 */
function snapshotForLog(row: AdminUserActionStateRow): {
  readonly status: UserStatusValue;
  readonly failedLoginCount: number;
  readonly lastFailedLoginAt: string | null;
  readonly lockedUntil: string | null;
} {
  return {
    status: row.status,
    failedLoginCount: row.failedLoginCount,
    lastFailedLoginAt: row.lastFailedLoginAt?.toISOString() ?? null,
    lockedUntil: row.lockedUntil?.toISOString() ?? null,
  };
}
