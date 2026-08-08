import { z } from 'zod';

/**
 * Admin RBAC role-ASSIGNMENT HTTP DTOs (TS-292; PRD §10.12; PDD §10.3).
 *
 * The assignment surface — granting roles TO users — distinct from the
 * role-DEFINITION catalog (TS-290, `admin-roles.schema.ts`). Exposed by
 * service-identity and proxied by the api-gateway at the same paths:
 *
 *   - `GET  /api/v1/admin/users/:userId/role-assignments`
 *     Every assignment held by one user (`?includeInactive=true` opts
 *     revoked / expired rows in). Gated `rbac:read`.
 *
 *   - `POST /api/v1/admin/role-assignments`            — single grant
 *   - `POST /api/v1/admin/role-assignments/:id/revoke` — revoke
 *   - `POST /api/v1/admin/role-assignments/bulk-preview`
 *     Read-only validation of a parsed CSV batch — per-row verdicts,
 *     NO writes. Gated `rbac:read`.
 *   - `POST /api/v1/admin/role-assignments/bulk-commit`
 *     Applies the batch row-by-row with PARTIAL-SUCCESS semantics
 *     (each grant is independent; a failed row never rolls back a
 *     prior one). Gated `rbac:write`.
 *
 * **CSV parsing happens in web-admin.** The wire carries structured
 * rows, never raw CSV text. Bulk-row fields are deliberately
 * loose-but-bounded strings: semantic validation (scope shape, datetime
 * parse, catalog membership) is the SERVICE's job so every row gets a
 * per-row verdict instead of the whole batch 400-ing on the first bad
 * cell.
 *
 * **Sensitive roles are not grantable here.** `super_admin` and
 * `finance` grants require the reviewer-approval flow (TS-294 — data
 * model landed with TS-024-followup-4); until that flow ships they are
 * rejected with a 403 pointing at it. The authoritative list lives in
 * service-identity's seed catalog; `ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES`
 * mirrors it for UI affordances (a drift guard in the identity tests
 * pins the two together).
 */

/** Max rows accepted by one bulk preview / commit call. */
export const ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS = 500;

/** Max length of an id (user, role, assignment — CUID-sized + headroom). */
export const ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH = 64;

/** Max length of a free-text reason riding the audit trail. */
export const ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH = 500;

/** Max assignments returned by the per-user list (bounded single page). */
export const ADMIN_ROLE_ASSIGNMENTS_LIST_MAX = 1000;

/** Max errors reported per bulk row (one per field + one row-level). */
export const ADMIN_ROLE_ASSIGNMENTS_ROW_ERRORS_MAX = 10;

/**
 * Roles that must NOT be granted via this surface — they take the
 * reviewer-approval flow (TS-294; CLAUDE.md §3.2 privilege-escalation
 * signoff). Mirrors `SENSITIVE_ROLE_NAMES` in service-identity's seed
 * catalog (authoritative); used by web-admin to hide the affordance.
 */
export const ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES = ['super_admin', 'finance'] as const;

const IdSchema = z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH);

const ReasonSchema = z.string().trim().min(1).max(ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH);

/**
 * Assignment scope as a discriminated union — mirrors the auth-sdk
 * `TenantScope` claim shape. `global` MUST NOT carry an id;
 * `tenant` / `household` MUST.
 */
export const AdminRoleAssignmentScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z.object({ type: z.literal('tenant'), tenantId: IdSchema }).strict(),
  z.object({ type: z.literal('household'), householdId: IdSchema }).strict(),
]);
export type AdminRoleAssignmentScope = z.infer<typeof AdminRoleAssignmentScopeSchema>;

// ─── Assignment records (reads) ──────────────────────────────────────────

/**
 * One assignment row. `active` reflects the server-time snapshot
 * (`revokedAt IS NULL AND not expired`); revoked / expired rows only
 * appear when the list opted in via `includeInactive`.
 */
export const AdminRoleAssignmentRecordSchema = z
  .object({
    id: IdSchema,
    userId: IdSchema,
    roleName: z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH),
    scope: AdminRoleAssignmentScopeSchema,
    active: z.boolean(),
    grantedByUserId: IdSchema.nullable(),
    expiresAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminRoleAssignmentRecord = z.infer<typeof AdminRoleAssignmentRecordSchema>;

/**
 * Query for the per-user list. `includeInactive` opts revoked /
 * expired rows in (repo idiom: `z.coerce.boolean()` — the UI only
 * sends the param when it wants them).
 */
export const AdminRoleAssignmentsListQuerySchema = z
  .object({
    includeInactive: z.coerce.boolean().optional(),
  })
  .strict();
export type AdminRoleAssignmentsListQuery = z.infer<typeof AdminRoleAssignmentsListQuerySchema>;

/** Response body for `GET /api/v1/admin/users/:userId/role-assignments`. */
export const AdminRoleAssignmentsListResponseSchema = z
  .object({
    assignments: z.array(AdminRoleAssignmentRecordSchema).max(ADMIN_ROLE_ASSIGNMENTS_LIST_MAX),
  })
  .strict();
export type AdminRoleAssignmentsListResponse = z.infer<
  typeof AdminRoleAssignmentsListResponseSchema
>;

/** Assignment envelope returned by the single grant. */
export const AdminRoleAssignmentResponseSchema = z
  .object({ assignment: AdminRoleAssignmentRecordSchema })
  .strict();
export type AdminRoleAssignmentResponse = z.infer<typeof AdminRoleAssignmentResponseSchema>;

// ─── Single grant / revoke ───────────────────────────────────────────────

/**
 * `POST /api/v1/admin/role-assignments` body. `expiresAt` (when
 * present) must be a FUTURE instant — enforced server-side (contracts
 * stay deterministic). Sensitive roles are rejected with 403; archived
 * roles with 409; a duplicate active assignment with 409 (the partial
 * unique index, TS-024-followup-3).
 */
export const GrantRoleAssignmentRequestSchema = z
  .object({
    userId: IdSchema,
    roleName: z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH),
    scope: AdminRoleAssignmentScopeSchema,
    expiresAt: z.string().datetime().optional(),
    reason: ReasonSchema.optional(),
  })
  .strict();
export type GrantRoleAssignmentRequest = z.infer<typeof GrantRoleAssignmentRequestSchema>;

/**
 * `POST /api/v1/admin/role-assignments/:id/revoke` body. The action is
 * mechanical; an optional `reason` rides the audit trail.
 */
export const RevokeRoleAssignmentRequestSchema = z
  .object({
    reason: ReasonSchema.optional(),
  })
  .strict();
export type RevokeRoleAssignmentRequest = z.infer<typeof RevokeRoleAssignmentRequestSchema>;

/**
 * Revoke response. `revoked: false` means the row was ALREADY revoked
 * — the operation is idempotent, not an error.
 */
export const RevokeRoleAssignmentResponseSchema = z.object({ revoked: z.boolean() }).strict();
export type RevokeRoleAssignmentResponse = z.infer<typeof RevokeRoleAssignmentResponseSchema>;

// ─── Bulk workflow ───────────────────────────────────────────────────────

/**
 * One parsed CSV row, exactly as the sheet's columns read:
 * `(userId, roleName, scopeType, scopeId, expiresAt)`. Fields are
 * loose-but-bounded ON PURPOSE — the service validates semantics
 * per-row (scopeType enum, scope-id presence, ISO datetime, catalog
 * membership) so a typo in row 37 yields a row-37 verdict, not a
 * batch-wide 400. Empty CSV cells arrive as `null`.
 */
export const BulkRoleAssignmentRowSchema = z
  .object({
    userId: z.string().trim().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH),
    roleName: z.string().trim().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH),
    scopeType: z.string().trim().min(1).max(32),
    scopeId: z.string().trim().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH).nullable(),
    expiresAt: z.string().trim().min(1).max(64).nullable(),
  })
  .strict();
export type BulkRoleAssignmentRow = z.infer<typeof BulkRoleAssignmentRowSchema>;

const BulkRowsSchema = z
  .array(BulkRoleAssignmentRowSchema)
  .min(1)
  .max(ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS);

/** Body for `POST /api/v1/admin/role-assignments/bulk-preview`. */
export const BulkRoleAssignmentsPreviewRequestSchema = z.object({ rows: BulkRowsSchema }).strict();
export type BulkRoleAssignmentsPreviewRequest = z.infer<
  typeof BulkRoleAssignmentsPreviewRequestSchema
>;

/** Which CSV column a row error names; `row` = cross-field problems. */
export const BULK_ROLE_ASSIGNMENT_ERROR_FIELDS = [
  'userId',
  'roleName',
  'scopeType',
  'scopeId',
  'expiresAt',
  'row',
] as const;
export const BulkRoleAssignmentErrorFieldSchema = z.enum(BULK_ROLE_ASSIGNMENT_ERROR_FIELDS);
export type BulkRoleAssignmentErrorField = z.infer<typeof BulkRoleAssignmentErrorFieldSchema>;

const BulkRowErrorSchema = z
  .object({
    field: BulkRoleAssignmentErrorFieldSchema,
    message: z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH),
  })
  .strict();

/**
 * The validated grant a row normalizes to — what bulk-commit will pass
 * to `RoleAssignmentService.grant`. Null on error rows.
 */
export const BulkRoleAssignmentNormalizedSchema = z
  .object({
    userId: IdSchema,
    roleName: z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH),
    scope: AdminRoleAssignmentScopeSchema,
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();
export type BulkRoleAssignmentNormalized = z.infer<typeof BulkRoleAssignmentNormalizedSchema>;

/** Per-row preview verdict. `index` is the 0-based position in `rows`. */
export const BulkRoleAssignmentVerdictSchema = z
  .object({
    index: z.number().int().min(0),
    ok: z.boolean(),
    errors: z.array(BulkRowErrorSchema).max(ADMIN_ROLE_ASSIGNMENTS_ROW_ERRORS_MAX),
    normalized: BulkRoleAssignmentNormalizedSchema.nullable(),
  })
  .strict();
export type BulkRoleAssignmentVerdict = z.infer<typeof BulkRoleAssignmentVerdictSchema>;

/** Response body for bulk-preview. */
export const BulkRoleAssignmentsPreviewResponseSchema = z
  .object({
    verdicts: z.array(BulkRoleAssignmentVerdictSchema).max(ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS),
    okCount: z.number().int().min(0),
    errorCount: z.number().int().min(0),
  })
  .strict();
export type BulkRoleAssignmentsPreviewResponse = z.infer<
  typeof BulkRoleAssignmentsPreviewResponseSchema
>;

/**
 * Body for `POST /api/v1/admin/role-assignments/bulk-commit` — the
 * same row shape as preview (the commit re-validates server-side;
 * invalid rows come back as per-row `error` outcomes, never a batch
 * failure).
 */
export const BulkRoleAssignmentsCommitRequestSchema = z.object({ rows: BulkRowsSchema }).strict();
export type BulkRoleAssignmentsCommitRequest = z.infer<
  typeof BulkRoleAssignmentsCommitRequestSchema
>;

/**
 * Per-row commit outcome. `granted` carries the new assignment id;
 * `conflict` means an identical active assignment already existed
 * (409 semantics — the row is a no-op, not a failure of the batch);
 * `error` carries the rejection detail (validation, sensitive role,
 * archived role, unknown user…).
 */
export const BULK_ROLE_ASSIGNMENT_OUTCOME_STATUSES = ['granted', 'conflict', 'error'] as const;
export const BulkRoleAssignmentOutcomeStatusSchema = z.enum(BULK_ROLE_ASSIGNMENT_OUTCOME_STATUSES);
export type BulkRoleAssignmentOutcomeStatus = z.infer<typeof BulkRoleAssignmentOutcomeStatusSchema>;

export const BulkRoleAssignmentOutcomeSchema = z
  .object({
    index: z.number().int().min(0),
    status: BulkRoleAssignmentOutcomeStatusSchema,
    assignmentId: IdSchema.nullable(),
    message: z.string().max(ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH).nullable(),
  })
  .strict();
export type BulkRoleAssignmentOutcome = z.infer<typeof BulkRoleAssignmentOutcomeSchema>;

/** Response body for bulk-commit. */
export const BulkRoleAssignmentsCommitResponseSchema = z
  .object({
    outcomes: z.array(BulkRoleAssignmentOutcomeSchema).max(ADMIN_ROLE_ASSIGNMENTS_BULK_MAX_ROWS),
    grantedCount: z.number().int().min(0),
    conflictCount: z.number().int().min(0),
    errorCount: z.number().int().min(0),
  })
  .strict();
export type BulkRoleAssignmentsCommitResponse = z.infer<
  typeof BulkRoleAssignmentsCommitResponseSchema
>;
