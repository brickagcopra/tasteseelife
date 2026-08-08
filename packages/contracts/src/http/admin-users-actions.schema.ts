import { z } from 'zod';

import { ADMIN_USERS_USER_ID_MAX_LENGTH } from './admin-users.schema';
import { AdminUserSummarySchema } from './admin-users.schema';
import { UserStatusSchema } from './auth.schema';

/**
 * Admin users management HTTP DTOs — mutation surface
 * (TS-126-followup-1; PRD §10.2; closes TS-025-followup-2).
 *
 * Three write surfaces complement the read-only `admin-users.schema.ts`:
 *
 *   - `POST /api/v1/admin/users/:id/suspend`
 *     Transitions `users.status` `active → suspended`. Requires a
 *     `reason` (categorical) + optional free-text `note` for the audit
 *     trail. Idempotent — a second call with the same Idempotency-Key
 *     replays the cached response without re-firing the transition.
 *
 *   - `POST /api/v1/admin/users/:id/reinstate`
 *     Transitions `users.status` `suspended → active`. Same payload
 *     shape as suspend (reason + optional note). Phase 1 does NOT
 *     support reinstating a `deactivated` user (the lifecycle implies
 *     permanent close); that path will land with a separate restore
 *     endpoint when product justifies it.
 *
 *   - `POST /api/v1/admin/users/:id/unlock`
 *     Clears `lockedUntil`, `failedLoginCount`, `lastFailedLoginAt`.
 *     Idempotent — calling on an already-clear account is a no-op
 *     success (200) rather than a 409. No status transition; the
 *     account's `status` is unaffected.
 *
 * **Audit.** Every mutation is intended to emit a `service-audit`
 * outbox event (TS-126-followup-5). Slice 1 of this slice ships only
 * structured `logger.log` lines as a forward-compat scaffold for the
 * audit pipe; once TS-100 lands the wiring upgrades transparently.
 *
 * **Authorisation.** All three endpoints sit behind
 * `AccessTokenGuard` → `SuperAdminRoleGuard`. The api-gateway proxy
 * enforces the same gate at the edge for defence-in-depth. Per-
 * permission gating (`user:suspend` etc.) replaces the hard-wired
 * `super_admin` check with TS-126-followup-10 once `PermissionGuard`
 * lifts to `packages/nest-auth` (TS-052-followup-11).
 *
 * **`.strict()`** everywhere — unknown fields are a parse error so a
 * typo or stray field never silently round-trips.
 */

/**
 * Max length of the free-text `note` field. Bounded to defeat
 * accidental megabyte payloads from a sloppy admin tool. Longer
 * detail belongs in the audit log or in a follow-up ticket.
 */
export const ADMIN_USERS_ACTION_NOTE_MAX_LENGTH = 500;

/**
 * Categorical suspension reasons. Kept short so the dropdown UX stays
 * crisp and the audit-aggregate metrics make sense per-category.
 * Free-text `note` carries the specifics.
 */
export const ADMIN_USERS_SUSPEND_REASONS = [
  'trust_safety',
  'payment_issue',
  'investigation',
  'user_request',
  'other',
] as const;

export const SuspendUserReasonSchema = z.enum(ADMIN_USERS_SUSPEND_REASONS);
export type SuspendUserReason = z.infer<typeof SuspendUserReasonSchema>;

/**
 * Categorical reinstatement reasons. Smaller set than suspend — the
 * reinstate path's audit story is mostly "the underlying issue is
 * resolved", so the categories are the resolution kinds rather than
 * the original cause.
 */
export const ADMIN_USERS_REINSTATE_REASONS = [
  'investigation_complete',
  'payment_resolved',
  'user_request',
  'other',
] as const;

export const ReinstateUserReasonSchema = z.enum(ADMIN_USERS_REINSTATE_REASONS);
export type ReinstateUserReason = z.infer<typeof ReinstateUserReasonSchema>;

/**
 * Action discriminator on the response. Lets the same response shape
 * round-trip from all three endpoints without the consumer having to
 * route on the URL.
 */
export const AdminUserActionKindSchema = z.enum(['suspend', 'reinstate', 'unlock']);
export type AdminUserActionKind = z.infer<typeof AdminUserActionKindSchema>;

const NoteSchema = z.string().min(1).max(ADMIN_USERS_ACTION_NOTE_MAX_LENGTH).optional();

export const SuspendUserRequestSchema = z
  .object({
    reason: SuspendUserReasonSchema,
    note: NoteSchema,
  })
  .strict();
export type SuspendUserRequest = z.infer<typeof SuspendUserRequestSchema>;

export const ReinstateUserRequestSchema = z
  .object({
    reason: ReinstateUserReasonSchema,
    note: NoteSchema,
  })
  .strict();
export type ReinstateUserRequest = z.infer<typeof ReinstateUserRequestSchema>;

/**
 * Unlock has no categorical reason — the action is mechanical (clear
 * the lockout counter) and the audit pipe captures "who unlocked at
 * what time" without needing a categorical bucket. A `note` is still
 * allowed for the free-text trail.
 */
export const UnlockUserRequestSchema = z
  .object({
    note: NoteSchema,
  })
  .strict();
export type UnlockUserRequest = z.infer<typeof UnlockUserRequestSchema>;

/**
 * Minimal before/after snapshot. Carries only the columns the three
 * actions actually touch — full row-level diff lives in the audit
 * event (TS-126-followup-5) when that pipe lands.
 *
 * `status` reflects `users.status` (one of `pending_verification |
 * active | suspended | deactivated`). The three lockout columns
 * mirror `users.failed_login_count / last_failed_login_at /
 * locked_until` as observed at the read-then-write boundary.
 *
 * Note: this is a snapshot of the row, NOT a delta — the consumer
 * computes the delta by comparing `before` vs `after`. Suspend
 * surfaces a status flip; unlock surfaces lockout-column changes.
 */
export const AdminUserActionStateSnapshotSchema = z
  .object({
    status: UserStatusSchema,
    failedLoginCount: z.number().int().nonnegative(),
    lastFailedLoginAt: z.string().datetime().nullable(),
    lockedUntil: z.string().datetime().nullable(),
    currentlyLocked: z.boolean(),
  })
  .strict();
export type AdminUserActionStateSnapshot = z.infer<typeof AdminUserActionStateSnapshotSchema>;

/**
 * Common response shape for all three mutation endpoints. The
 * discriminator (`action`) plus `reason` (nullable for unlock) keeps
 * one Zod schema serving all three without a discriminated union
 * complication on the consumer side.
 */
export const AdminUserActionResponseSchema = z
  .object({
    user: AdminUserSummarySchema,
    action: AdminUserActionKindSchema,
    /** Server-stamped ISO timestamp of when the transition committed. */
    performedAt: z.string().datetime(),
    /**
     * The admin user id (from the access token's RequestContext) that
     * performed the action. Same column the audit-log entry uses.
     */
    performedByUserId: z.string().min(1).max(ADMIN_USERS_USER_ID_MAX_LENGTH),
    /**
     * State snapshot immediately before the transition. For unlock,
     * surfaces the lockout columns the action reset.
     */
    before: AdminUserActionStateSnapshotSchema,
    /** State snapshot immediately after the transition. */
    after: AdminUserActionStateSnapshotSchema,
    /**
     * The categorical reason supplied with the request. Null for
     * unlock (which has no categorical reason). Suspend / reinstate
     * always carry one of their enum values.
     */
    reason: z.union([SuspendUserReasonSchema, ReinstateUserReasonSchema]).nullable(),
    /** Optional free-text note carried verbatim from the request. */
    note: z.string().min(1).max(ADMIN_USERS_ACTION_NOTE_MAX_LENGTH).nullable(),
  })
  .strict();
export type AdminUserActionResponse = z.infer<typeof AdminUserActionResponseSchema>;
