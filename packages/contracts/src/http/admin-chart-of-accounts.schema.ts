import { z } from 'zod';

import { AccountSchema } from './account.schema';

/**
 * Admin chart-of-accounts HTTP DTOs (TS-129-followup-1; PRD §10.8,
 * PDD §11.2, CLAUDE.md §6).
 *
 * Mutation surface for the admin chart-of-accounts browser:
 *
 *   - `PATCH /api/v1/admin/accounts/:id`
 *     Flip an account's `active` flag (retire / activate). CLAUDE.md §6
 *     forbids deleting a chart-of-accounts row — historical journals
 *     point at it forever — so retirement is the closest "delete"
 *     gesture available. Re-activation is the inverse.
 *
 *     The endpoint is idempotent on `Idempotency-Key`; a second call
 *     with the same key + body replays the cached response. A call
 *     that targets the same end-state without an Idempotency-Key is
 *     also a no-op success — toggling to the current state returns
 *     200 with `before == after`. Mismatched-key + same-body → 409
 *     (client bug); same-key + different-body → 409 (also client
 *     bug).
 *
 * **Authorisation.** The endpoint sits behind `AccessTokenGuard` →
 * `SuperAdminRoleGuard`. The api-gateway proxy enforces the same gate
 * at the edge for defence-in-depth. Per-permission gating
 * (`accounting:adjust`) replaces the hard-wired `super_admin` check
 * via TS-129-followup-2 once `PermissionGuard` lifts to
 * `packages/nest-auth` (TS-052-followup-11).
 *
 * **Audit.** Each successful transition emits a structured
 * `logger.log` line carrying actor + before/after + reason + note as a
 * forward-compat scaffold for the audit pipe (TS-129-followup-3); once
 * TS-100 audit-svc is up the service-layer log emission is replaced by
 * an outbox event with the same payload shape.
 *
 * **`.strict()`** everywhere — unknown fields are a parse error so a
 * typo or stray field never silently round-trips.
 */

/**
 * Max length of the free-text `note` field. Bounded to defeat
 * accidental megabyte payloads from a sloppy admin tool. Longer
 * detail belongs in the audit log or in a follow-up ticket. Mirrors
 * `ADMIN_USERS_ACTION_NOTE_MAX_LENGTH`.
 */
export const ADMIN_ACCOUNTS_ACTION_NOTE_MAX_LENGTH = 500;

/**
 * Categorical reasons for flipping the `active` flag. Kept short so
 * the dropdown UX stays crisp and the audit aggregates make sense
 * per-category. Free-text `note` carries the specifics.
 *
 *   - `superseded`     — a successor account took over; this one is
 *                        no longer the canonical destination.
 *   - `chart_cleanup`  — periodic catalog hygiene retiring an unused
 *                        sub-account.
 *   - `restore`        — re-activating a previously-retired account.
 *   - `other`          — escape hatch; reach for the `note` field.
 */
export const ADMIN_ACCOUNTS_ACTIVE_REASONS = [
  'superseded',
  'chart_cleanup',
  'restore',
  'other',
] as const;

export const AdminAccountActiveReasonSchema = z.enum(ADMIN_ACCOUNTS_ACTIVE_REASONS);
export type AdminAccountActiveReason = z.infer<typeof AdminAccountActiveReasonSchema>;

const NoteSchema = z.string().min(1).max(ADMIN_ACCOUNTS_ACTION_NOTE_MAX_LENGTH).optional();

/**
 * Body for `PATCH /api/v1/admin/accounts/:id`.
 *
 *   - `active` — the target end-state. Toggling to the current state
 *     is a no-op success (idempotent).
 *   - `reason` — categorical bucket for the audit pipe. Required so
 *     the audit log carries the "why" for every transition.
 *   - `note`   — optional free-text. Trimmed; empty becomes undefined.
 */
export const UpdateAccountActiveRequestSchema = z
  .object({
    active: z.boolean(),
    reason: AdminAccountActiveReasonSchema,
    note: NoteSchema,
  })
  .strict();
export type UpdateAccountActiveRequest = z.infer<typeof UpdateAccountActiveRequestSchema>;

/**
 * Minimal before/after snapshot. Carries the columns this action
 * touches — full row-level diff lives in the audit event when that
 * pipe lands (TS-129-followup-3). Mirrors
 * `AdminUserActionStateSnapshotSchema` shape.
 */
export const AdminAccountActiveStateSnapshotSchema = z
  .object({
    active: z.boolean(),
  })
  .strict();
export type AdminAccountActiveStateSnapshot = z.infer<typeof AdminAccountActiveStateSnapshotSchema>;

/**
 * Response body for `PATCH /api/v1/admin/accounts/:id`.
 *
 * Returns the updated row plus before/after snapshots, the reason +
 * note, and the actor + transition timestamp.
 */
export const UpdateAccountActiveResponseSchema = z
  .object({
    account: AccountSchema,
    /** Server-stamped ISO timestamp of when the transition committed. */
    performedAt: z.string().datetime(),
    /**
     * The admin user id (from the access token's RequestContext) that
     * performed the action.
     */
    performedByUserId: z.string().min(1).max(64),
    /** State snapshot immediately before the transition. */
    before: AdminAccountActiveStateSnapshotSchema,
    /** State snapshot immediately after the transition. */
    after: AdminAccountActiveStateSnapshotSchema,
    /** Categorical reason from the request, echoed for audit symmetry. */
    reason: AdminAccountActiveReasonSchema,
    /** Optional free-text note carried verbatim from the request. */
    note: z.string().min(1).max(ADMIN_ACCOUNTS_ACTION_NOTE_MAX_LENGTH).nullable(),
  })
  .strict();
export type UpdateAccountActiveResponse = z.infer<typeof UpdateAccountActiveResponseSchema>;
