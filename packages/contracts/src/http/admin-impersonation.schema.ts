import { z } from 'zod';

import { ADMIN_USERS_USER_ID_MAX_LENGTH } from './admin-users.schema';
import { UserStatusSchema } from './auth.schema';

/**
 * Admin impersonation HTTP DTOs (TS-297; PRD §10.2; CLAUDE.md §3.6).
 *
 * Two surfaces:
 *
 *   - `POST /api/v1/admin/users/:id/impersonate`
 *     Mints a short-lived session IN THE TARGET USER'S NAME for
 *     diagnostic support work. The access token's `sub` is the
 *     impersonated user (so downstream authorisation acts as them);
 *     the RFC 8693-inspired `actorOnBehalfOf` claim carries the
 *     operator's user id so the true actor identity is preserved
 *     everywhere the token travels. Requires the `user:impersonate`
 *     permission (super_admin only in Phase 1). Refused for
 *     self-impersonation and for targets holding any admin-staff
 *     role (privilege laundering). Start + end are audit-logged.
 *
 *   - `POST /api/v1/admin/impersonation/end`
 *     Revokes the impersonation session family. Idempotent — ending
 *     an already-ended session reports `ended: false` rather than
 *     erroring, so a double-click or a retry converges.
 *
 * **Scope (TS-297).** This is the identity-side core: mint, label,
 * audit, revoke. Swapping the impersonation session into the actual
 * family/provider portal origin is TS-126-followup-2; propagating
 * the operator identity into downstream services' own audit trails
 * via the internal trust headers is a carved follow-up.
 *
 * **Token handling.** The response carries the raw tokens in the
 * JSON body (TLS-only, admin-authenticated surface). Consumers MUST
 * store them in HttpOnly cookies or server-side state — never
 * localStorage (CLAUDE.md §3.1) — and MUST NOT log them.
 */

export const ADMIN_IMPERSONATION_REASON_MAX_LENGTH = 500;

/**
 * Why the operator is impersonating — required free text for the
 * audit trail (mirrors the role-approval request's mandatory reason:
 * privileged actions carry a stated justification, CLAUDE.md §3.2).
 */
export const ImpersonateUserRequestSchema = z
  .object({
    reason: z.string().min(1).max(ADMIN_IMPERSONATION_REASON_MAX_LENGTH),
  })
  .strict();
export type ImpersonateUserRequest = z.infer<typeof ImpersonateUserRequestSchema>;

/** The impersonated account, echoed so the UI can label the session. */
export const ImpersonatedUserSummarySchema = z
  .object({
    id: z.string().min(1).max(ADMIN_USERS_USER_ID_MAX_LENGTH),
    email: z.string().email(),
    status: UserStatusSchema,
  })
  .strict();
export type ImpersonatedUserSummary = z.infer<typeof ImpersonatedUserSummarySchema>;

export const ImpersonateUserResponseSchema = z
  .object({
    /** Bearer access token whose `sub` is the impersonated user. */
    accessToken: z.string().min(1),
    tokenType: z.literal('Bearer'),
    /** Access-token lifetime in seconds (standard 15-minute JWT). */
    expiresIn: z.number().int().positive(),
    /**
     * Raw refresh token for the impersonation family. Carried for the
     * portal cookie-swap flow (TS-126-followup-2); the web-admin
     * diagnostic surface ignores it. The family is capped at the
     * impersonation TTL — far shorter than an ordinary session.
     */
    refreshToken: z.string().min(1),
    /**
     * Refresh-token family id (also the access token's `sid` claim).
     * Pass to the end endpoint to terminate the session.
     */
    sessionFamilyId: z.string().min(1).max(64),
    /** Absolute expiry of the impersonation session family (ISO). */
    sessionExpiresAt: z.string().datetime(),
    /** The operator's user id — mirrors the token's `actorOnBehalfOf`. */
    operatorUserId: z.string().min(1).max(ADMIN_USERS_USER_ID_MAX_LENGTH),
    user: ImpersonatedUserSummarySchema,
  })
  .strict();
export type ImpersonateUserResponse = z.infer<typeof ImpersonateUserResponseSchema>;

export const EndImpersonationRequestSchema = z
  .object({
    sessionFamilyId: z.string().min(1).max(64),
  })
  .strict();
export type EndImpersonationRequest = z.infer<typeof EndImpersonationRequestSchema>;

export const EndImpersonationResponseSchema = z
  .object({
    sessionFamilyId: z.string().min(1).max(64),
    /**
     * True when this call revoked at least one live token; false when
     * the family was already fully revoked or expired (idempotent
     * convergence — not an error).
     */
    ended: z.boolean(),
    endedAt: z.string().datetime(),
  })
  .strict();
export type EndImpersonationResponse = z.infer<typeof EndImpersonationResponseSchema>;
