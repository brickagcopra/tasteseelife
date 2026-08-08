import { z } from 'zod';

/**
 * Dedicated culinary-concierge assignment HTTP DTOs (TS-222; PRD §5.1
 * Tier 3 "Dedicated culinary concierge", §6.6; PDD §10.6).
 *
 * Two surfaces share this contract:
 *
 *   1. **Internal admin** — `POST   /api/v1/concierge/assignments`
 *      (create / replace), `GET    /api/v1/concierge/assignments?householdId=…`
 *      (per-household history), `DELETE /api/v1/concierge/assignments/:assignmentId`
 *      (end the active assignment). The api-gateway BFF
 *      (`AdminConciergeAssignmentsProxyController`) forwards super_admin-gated
 *      writes from web-admin; service-concierge enforces the same `super_admin`
 *      gate for defence-in-depth. Assigning a dedicated concierge is an ops
 *      action (PDD §10.6 "Assignment to concierge staff"), never a family
 *      self-service one.
 *
 *   2. **Family read** — `GET /api/v1/concierge/assignments/me`. Resolves the
 *      household from the actor token's `tenantScope: {type:'household', …}`
 *      claim and returns the single ACTIVE assignment (or `null`) so the
 *      family portal can render the "Your concierge" card. No household id
 *      crosses the wire — the token is the household-membership trust
 *      boundary (service-concierge cannot read `household.household_members`,
 *      CLAUDE.md §2.3).
 *
 * **Reassignment model.** One ACTIVE assignment per household. A create
 * call ends any prior active assignment (`status=ended`, `ended_at` set)
 * and inserts a fresh active row, so the full history is preserved for the
 * audit trail (PDD §17 — "who was the concierge the night the welfare flag
 * fired"). The active row is what the family card reads.
 *
 * **Concierge display names** are captured at assignment time rather than
 * resolved cross-service from `identity.users` on every card render: the
 * concierge's user id is a soft FK (CLAUDE.md §2.3 — no cross-service join)
 * and the assigning admin already knows the name. Name-sync on the rare
 * rename is a deferred follow-up (TS-222-followup-1).
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/** CUID/CUID2-shaped assignment-row id cap. */
export const CONCIERGE_ASSIGNMENT_ID_MAX_LENGTH = 64;

/** Soft-FK household id cap — matches `household.households.id`. */
export const CONCIERGE_ASSIGNMENT_HOUSEHOLD_ID_MAX_LENGTH = 64;

/** Soft-FK user id cap — matches `identity.users.id` (concierge + assigning admin). */
export const CONCIERGE_ASSIGNMENT_USER_ID_MAX_LENGTH = 64;

/** Display name shown on the family "Your concierge" card + admin row. */
export const CONCIERGE_ASSIGNMENT_DISPLAY_NAME_MAX_LENGTH = 120;

/** Admin per-household history pagination caps. Ops tool, low volume — bounded, no cursor (Phase 1). */
export const CONCIERGE_ASSIGNMENT_LIST_LIMIT_DEFAULT = 50;
export const CONCIERGE_ASSIGNMENT_LIST_LIMIT_MAX = 200;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONCIERGE_ASSIGNMENT_ID_MAX_LENGTH);
const HouseholdIdSchema = z.string().min(1).max(CONCIERGE_ASSIGNMENT_HOUSEHOLD_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(CONCIERGE_ASSIGNMENT_USER_ID_MAX_LENGTH);
const DisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'a display name is required')
  .max(CONCIERGE_ASSIGNMENT_DISPLAY_NAME_MAX_LENGTH);

/**
 * Assignment lifecycle status.
 *   - `active` — the current dedicated concierge for the household. At most
 *     one active row per household (DB partial-unique index in TS-222).
 *   - `ended`  — superseded by a reassignment or explicitly ended by ops.
 *     Retained for the audit history.
 */
export const ConciergeAssignmentStatusSchema = z.enum(['active', 'ended']);
export type ConciergeAssignmentStatus = z.infer<typeof ConciergeAssignmentStatusSchema>;

// ─── Record / response shapes ───────────────────────────────────────────

/**
 * Full assignment record returned by every read endpoint.
 *
 *   - `backupConciergeUserId` / `backupConciergeDisplayName` — both null
 *     when no backup concierge is named; both non-null otherwise (the
 *     `superRefine` keeps them in lockstep).
 *   - `assignedByUserId` — the admin who created the assignment, null for
 *     rows created before actor attribution was wired or via a direct
 *     (non-gateway) call.
 *   - `endedAt` — null while `status==='active'`; set when the row is ended.
 */
export const ConciergeAssignmentRecordSchema = z
  .object({
    id: IdSchema,
    householdId: HouseholdIdSchema,
    primaryConciergeUserId: UserIdSchema,
    primaryConciergeDisplayName: DisplayNameSchema,
    backupConciergeUserId: UserIdSchema.nullable(),
    backupConciergeDisplayName: DisplayNameSchema.nullable(),
    status: ConciergeAssignmentStatusSchema,
    assignedByUserId: UserIdSchema.nullable(),
    startedAt: z.string().datetime({ offset: true }),
    endedAt: z.string().datetime({ offset: true }).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((rec, ctx) => {
    const hasBackupId = rec.backupConciergeUserId !== null;
    const hasBackupName = rec.backupConciergeDisplayName !== null;
    if (hasBackupId !== hasBackupName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backupConciergeDisplayName'],
        message:
          'backupConciergeUserId and backupConciergeDisplayName must both be present or both be null',
      });
    }
  });
export type ConciergeAssignmentRecord = z.infer<typeof ConciergeAssignmentRecordSchema>;

/**
 * `POST /api/v1/concierge/assignments` body — assign (or replace) the
 * dedicated concierge for a household.
 *
 * A backup concierge is optional; when supplied, both the user id and the
 * display name are required (the `superRefine` enforces both-or-neither).
 * The backup cannot be the same person as the primary. `assignedByUserId`
 * is the actor attribution the gateway stamps from the authenticated
 * super_admin — bypassed (null) by a direct internal call.
 */
export const CreateConciergeAssignmentRequestSchema = z
  .object({
    householdId: HouseholdIdSchema,
    primaryConciergeUserId: UserIdSchema,
    primaryConciergeDisplayName: DisplayNameSchema,
    backupConciergeUserId: UserIdSchema.optional(),
    backupConciergeDisplayName: DisplayNameSchema.optional(),
    assignedByUserId: UserIdSchema.optional(),
  })
  .strict()
  .superRefine((req, ctx) => {
    const hasBackupId = req.backupConciergeUserId !== undefined;
    const hasBackupName = req.backupConciergeDisplayName !== undefined;
    if (hasBackupId !== hasBackupName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backupConciergeDisplayName'],
        message:
          'backupConciergeUserId and backupConciergeDisplayName must both be present or both be omitted',
      });
    }
    if (
      req.backupConciergeUserId !== undefined &&
      req.backupConciergeUserId === req.primaryConciergeUserId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backupConciergeUserId'],
        message: 'the backup concierge must be a different person from the primary',
      });
    }
  });
export type CreateConciergeAssignmentRequest = z.infer<
  typeof CreateConciergeAssignmentRequestSchema
>;

/** `POST /api/v1/concierge/assignments` response — the created active row. */
export const CreateConciergeAssignmentResponseSchema = z
  .object({
    assignment: ConciergeAssignmentRecordSchema,
  })
  .strict();
export type CreateConciergeAssignmentResponse = z.infer<
  typeof CreateConciergeAssignmentResponseSchema
>;

/**
 * `GET /api/v1/concierge/assignments/me` response — the active assignment
 * for the actor's household, or `null` when the household has no dedicated
 * concierge (e.g. a non-Tier-3 household, or a Tier-3 household awaiting
 * its white-glove kickoff). `householdId` echoes the household the token
 * resolved to so the portal can correlate.
 */
export const ConciergeAssignmentSnapshotResponseSchema = z
  .object({
    householdId: HouseholdIdSchema,
    assignment: ConciergeAssignmentRecordSchema.nullable(),
  })
  .strict();
export type ConciergeAssignmentSnapshotResponse = z.infer<
  typeof ConciergeAssignmentSnapshotResponseSchema
>;

/**
 * `GET /api/v1/concierge/assignments` query. `householdId` is required —
 * the admin surface looks up a specific household's assignment history.
 * `activeOnly=true` restricts the result to the single active row.
 */
export const ListConciergeAssignmentsQuerySchema = z
  .object({
    householdId: HouseholdIdSchema,
    activeOnly: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_ASSIGNMENT_LIST_LIMIT_MAX)
      .default(CONCIERGE_ASSIGNMENT_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListConciergeAssignmentsQuery = z.infer<typeof ListConciergeAssignmentsQuerySchema>;

/**
 * `GET /api/v1/concierge/assignments` response — the household's assignment
 * history ordered active-first then by `started_at` descending.
 */
export const ConciergeAssignmentsListResponseSchema = z
  .object({
    assignments: z.array(ConciergeAssignmentRecordSchema),
  })
  .strict();
export type ConciergeAssignmentsListResponse = z.infer<
  typeof ConciergeAssignmentsListResponseSchema
>;

/**
 * `DELETE /api/v1/concierge/assignments/:assignmentId` response. Idempotent:
 *   - `ended`         — the active row was ended by this call.
 *   - `already_ended` — the row existed but was already ended (replay).
 *   - `not_found`     — no such assignment id (or soft-deleted).
 */
export const EndConciergeAssignmentResponseSchema = z
  .object({
    outcome: z.enum(['ended', 'already_ended', 'not_found']),
    assignmentId: IdSchema,
  })
  .strict();
export type EndConciergeAssignmentResponse = z.infer<typeof EndConciergeAssignmentResponseSchema>;
