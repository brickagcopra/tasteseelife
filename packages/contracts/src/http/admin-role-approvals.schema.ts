import { z } from 'zod';

import {
  ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH,
  ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH,
  AdminRoleAssignmentScopeSchema,
} from './admin-role-assignments.schema';

/**
 * Admin RBAC role-approval HTTP DTOs (TS-294; CLAUDE.md §3.2; PDD §10.3).
 *
 * The reviewer-required grant flow for SENSITIVE roles (`super_admin`,
 * `finance` — `ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES`): a grant request
 * enters a pending-approval state and a SECOND admin must approve before
 * the real `user_roles` row is minted. Exposed by service-identity and
 * proxied by the api-gateway at the same paths:
 *
 *   - `POST /api/v1/admin/role-approvals`               — request a grant
 *     (`rbac:write`; the requester CANNOT approve their own request)
 *   - `GET  /api/v1/admin/role-approvals?status=`       — reviewer queue /
 *     history (`rbac:read`)
 *   - `POST /api/v1/admin/role-approvals/:id/approve`   — second-admin
 *     approval (`rbac:write` + the approver must themselves hold
 *     `super_admin` — service-enforced; see below)
 *   - `POST /api/v1/admin/role-approvals/:id/reject`    — reviewer
 *     rejection, or requester self-cancel
 *
 * **Second-admin invariant.** `approvedByUserId` records the DECIDER for
 * both outcomes (the schema comment on `role_assignment_approvals`
 * documents the column as "when the reviewer decided"); the service
 * rejects approve calls where the decider equals `requestedByUserId`.
 *
 * **Approver privilege.** Holding `rbac:write` alone must not let an
 * operator mint a `super_admin` grant by approving it — the approve path
 * additionally requires the approver to hold an active `super_admin`
 * assignment (service-layer check on the token's roles claim).
 *
 * **The grant only becomes active on approval.** While a request is
 * pending there is NO `user_roles` row; `userRoleId` back-links the row
 * minted at approval time.
 */

/** Max approvals returned by one list call (bounded single page). */
export const ADMIN_ROLE_APPROVALS_LIST_MAX = 500;

/** Statuses an approval request moves through (mirrors the identity enum). */
export const ADMIN_ROLE_APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export const AdminRoleApprovalStatusSchema = z.enum(ADMIN_ROLE_APPROVAL_STATUSES);
export type AdminRoleApprovalStatus = z.infer<typeof AdminRoleApprovalStatusSchema>;

const IdSchema = z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH);
const NoteSchema = z.string().trim().min(1).max(ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH);

/**
 * One approval request. `reason` is the requester's justification
 * (required on the wire when requesting; nullable here because the
 * column predates the flow); `decisionNote` is the decider's optional
 * note; `approvedByUserId` is the decider for BOTH approve and reject
 * outcomes; `userRoleId` is the assignment minted on approval (null
 * for pending / rejected / expired rows).
 */
export const AdminRoleApprovalRecordSchema = z
  .object({
    id: IdSchema,
    userId: IdSchema,
    roleName: z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH),
    scope: AdminRoleAssignmentScopeSchema,
    expiresAt: z.string().datetime().nullable(),
    requestedByUserId: IdSchema,
    reason: z.string().max(ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH).nullable(),
    status: AdminRoleApprovalStatusSchema,
    approvedByUserId: IdSchema.nullable(),
    decidedAt: z.string().datetime().nullable(),
    decisionNote: z.string().max(ADMIN_ROLE_ASSIGNMENTS_REASON_MAX_LENGTH).nullable(),
    userRoleId: IdSchema.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type AdminRoleApprovalRecord = z.infer<typeof AdminRoleApprovalRecordSchema>;

/**
 * `POST /api/v1/admin/role-approvals` body. Unlike the direct grant,
 * `reason` is REQUIRED — privilege escalation always carries a why
 * (CLAUDE.md §3.2). Non-sensitive roles are 400 (use the direct grant);
 * a duplicate pending request for the same (user, role, scope) is 409;
 * a user already holding the role actively is 409 (nothing to approve).
 */
export const RequestRoleApprovalRequestSchema = z
  .object({
    userId: IdSchema,
    roleName: z.string().min(1).max(ADMIN_ROLE_ASSIGNMENTS_ID_MAX_LENGTH),
    scope: AdminRoleAssignmentScopeSchema,
    expiresAt: z.string().datetime().optional(),
    reason: NoteSchema,
  })
  .strict();
export type RequestRoleApprovalRequest = z.infer<typeof RequestRoleApprovalRequestSchema>;

/** Query for the list — optional status filter (`pending` = reviewer queue). */
export const AdminRoleApprovalsListQuerySchema = z
  .object({
    status: AdminRoleApprovalStatusSchema.optional(),
  })
  .strict();
export type AdminRoleApprovalsListQuery = z.infer<typeof AdminRoleApprovalsListQuerySchema>;

/** Response body for `GET /api/v1/admin/role-approvals`. */
export const AdminRoleApprovalsListResponseSchema = z
  .object({
    approvals: z.array(AdminRoleApprovalRecordSchema).max(ADMIN_ROLE_APPROVALS_LIST_MAX),
  })
  .strict();
export type AdminRoleApprovalsListResponse = z.infer<typeof AdminRoleApprovalsListResponseSchema>;

/** Approval envelope returned by request / approve / reject. */
export const AdminRoleApprovalResponseSchema = z
  .object({ approval: AdminRoleApprovalRecordSchema })
  .strict();
export type AdminRoleApprovalResponse = z.infer<typeof AdminRoleApprovalResponseSchema>;

/**
 * Body for approve / reject. `note` is the decider's optional
 * free-text (preserved on the row as `decisionNote` + audit trail).
 * Deliberately optional on BOTH paths: the requester's `reason` is
 * already on the row, and a self-cancel reject needs no ceremony.
 */
export const DecideRoleApprovalRequestSchema = z
  .object({
    note: NoteSchema.optional(),
  })
  .strict();
export type DecideRoleApprovalRequest = z.infer<typeof DecideRoleApprovalRequestSchema>;
