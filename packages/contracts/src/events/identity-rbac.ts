import { z } from 'zod';

/**
 * Identity RBAC domain event (TS-293; PRD §10.12; PDD §10.3; CLAUDE.md §3.2).
 *
 * `identity.role_assignment.expired` — emitted by `service-identity`'s
 * scheduled rbac-revoker sweep when a role assignment whose `expires_at`
 * has passed is durably revoked (`revoked_at` stamped).
 *
 * **Why an event, not a direct call.** The sweep is an identity-side state
 * change (the row flips to revoked); "tell the user their access lapsed"
 * is a cross-service concern owned by `service-notification`
 * (TS-293-followup — the consumer is carved per the seam-and-stub steer).
 * The producer appends this event to `identity.outbox_events` *inside the
 * same Prisma transaction as the revocation* (CLAUDE.md §5.3 outbox
 * pattern), so a revoked row is guaranteed to have durably queued its
 * notification signal and a rolled-back sweep batch never emits. The relay
 * (`worker-outbox-relay`) already drains `identity.outbox_events` — a new
 * event NAME on the same table needs no relay-config change. Consumers are
 * idempotent on `eventId`.
 *
 * **Expiry is already enforced at read time** — expired assignments never
 * reach a token (`getActiveAssignments` filters on `expires_at`). This
 * event marks the *durable* revocation, which is what the notification
 * and audit trail hang off.
 *
 * **No PII.** The payload names ids + the role name — never an email,
 * display name, or scope-resolved entity. The consumer resolves the
 * recipient itself.
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The constant
 * is the single source of truth — services import the literal, so a rename
 * is a TS error at every call site.
 */
export const IDENTITY_ROLE_ASSIGNMENT_EXPIRED = 'identity.role_assignment.expired' as const;

/** Soft id cap — user_roles / users ids are CUID-shaped; 64 leaves headroom. */
export const IDENTITY_RBAC_EVENT_ID_MAX_LENGTH = 64;
/** Role name cap — mirrors the admin-roles contract's role-name bound. */
export const IDENTITY_RBAC_EVENT_ROLE_NAME_MAX_LENGTH = 64;
/** Scope id cap — tenant / household ids are soft refs; mirrors user_roles.scope_id usage. */
export const IDENTITY_RBAC_EVENT_SCOPE_ID_MAX_LENGTH = 128;

/**
 * Scope type as stored on `identity.user_roles.scope_type`. Kept flat
 * (`scopeType` + nullable `scopeId`) rather than a discriminated union —
 * events favour the storage encoding; the auth-sdk's `TenantScope` union
 * is an HTTP/claims concern.
 */
export const IdentityRbacScopeTypeSchema = z.enum(['global', 'tenant', 'household']);
export type IdentityRbacScopeType = z.infer<typeof IdentityRbacScopeTypeSchema>;

/**
 * Common event envelope — every event carries `eventId` (consumer dedup key
 * per CLAUDE.md §5.3) and `occurredAt` (producer wall-clock timestamp).
 * Same shape as the audit / booking / content events.
 */
const IdentityRbacEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * `identity.role_assignment.expired` payload (TS-293) — one revoked-on-expiry
 * assignment.
 *
 *   - `assignmentId` — the `user_roles` row that was revoked.
 *   - `userId` — who held the assignment (the notification recipient).
 *   - `roleName` — the role that lapsed (for the notification copy).
 *   - `scopeType` / `scopeId` — the assignment's scope as stored
 *     (`scopeId` null iff `scopeType === 'global'`).
 *   - `expiresAt` — the moment the assignment expired (from the row).
 *   - `revokedAt` — when the sweep durably revoked it (>= expiresAt;
 *     the sweep runs on an interval).
 */
export const IdentityRoleAssignmentExpiredSchema = IdentityRbacEventEnvelopeSchema.extend({
  assignmentId: z.string().min(1).max(IDENTITY_RBAC_EVENT_ID_MAX_LENGTH),
  userId: z.string().min(1).max(IDENTITY_RBAC_EVENT_ID_MAX_LENGTH),
  roleName: z.string().min(1).max(IDENTITY_RBAC_EVENT_ROLE_NAME_MAX_LENGTH),
  scopeType: IdentityRbacScopeTypeSchema,
  scopeId: z.string().min(1).max(IDENTITY_RBAC_EVENT_SCOPE_ID_MAX_LENGTH).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  revokedAt: z.string().datetime({ offset: true }),
}).strict();
export type IdentityRoleAssignmentExpired = z.infer<typeof IdentityRoleAssignmentExpiredSchema>;

// ─── Reviewer-approval flow (TS-294) ─────────────────────────────────────

/**
 * `identity.role_assignment_approval.requested` — a sensitive-role grant
 * request entered the pending-approval state (TS-294; CLAUDE.md §3.2).
 * Emitted inside the same transaction as the `role_assignment_approvals`
 * insert (§5.3 outbox). Consumers: the (carved) notification that a
 * reviewer has a request waiting, and the audit trail.
 */
export const IDENTITY_ROLE_ASSIGNMENT_APPROVAL_REQUESTED =
  'identity.role_assignment_approval.requested' as const;

/**
 * `identity.role_assignment_approval.decided` — a pending request reached
 * a terminal state. `status` is the outcome; `decidedByUserId` is the
 * second admin (approve) or the rejecting decider — possibly the
 * requester self-cancelling; null when a future staleness sweep expires
 * the request with no human decider. `userRoleId` is the assignment
 * minted on approval (null otherwise). Both actor ids ride the event so
 * the audit trail captures requester AND approver (TS-294 acceptance).
 */
export const IDENTITY_ROLE_ASSIGNMENT_APPROVAL_DECIDED =
  'identity.role_assignment_approval.decided' as const;

/** Terminal outcomes carried by the decided event (never `pending`). */
export const IdentityRoleApprovalOutcomeSchema = z.enum(['approved', 'rejected', 'expired']);
export type IdentityRoleApprovalOutcome = z.infer<typeof IdentityRoleApprovalOutcomeSchema>;

const ApprovalEventCoreSchema = IdentityRbacEventEnvelopeSchema.extend({
  approvalId: z.string().min(1).max(IDENTITY_RBAC_EVENT_ID_MAX_LENGTH),
  userId: z.string().min(1).max(IDENTITY_RBAC_EVENT_ID_MAX_LENGTH),
  roleName: z.string().min(1).max(IDENTITY_RBAC_EVENT_ROLE_NAME_MAX_LENGTH),
  scopeType: IdentityRbacScopeTypeSchema,
  scopeId: z.string().min(1).max(IDENTITY_RBAC_EVENT_SCOPE_ID_MAX_LENGTH).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  requestedByUserId: z.string().min(1).max(IDENTITY_RBAC_EVENT_ID_MAX_LENGTH),
});

export const IdentityRoleAssignmentApprovalRequestedSchema = ApprovalEventCoreSchema.strict();
export type IdentityRoleAssignmentApprovalRequested = z.infer<
  typeof IdentityRoleAssignmentApprovalRequestedSchema
>;

export const IdentityRoleAssignmentApprovalDecidedSchema = ApprovalEventCoreSchema.extend({
  status: IdentityRoleApprovalOutcomeSchema,
  decidedByUserId: z.string().min(1).max(IDENTITY_RBAC_EVENT_ID_MAX_LENGTH).nullable(),
  decidedAt: z.string().datetime({ offset: true }),
  userRoleId: z.string().min(1).max(IDENTITY_RBAC_EVENT_ID_MAX_LENGTH).nullable(),
}).strict();
export type IdentityRoleAssignmentApprovalDecided = z.infer<
  typeof IdentityRoleAssignmentApprovalDecidedSchema
>;
