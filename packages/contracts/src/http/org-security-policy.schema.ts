import { z } from 'zod';

/**
 * Org security-policy HTTP DTOs (TS-296; CLAUDE.md §3.1; PDD §10.1).
 *
 * Identity has no org/tenant ENTITY — tenancy is the bare `scopeId`
 * string on tenant-scoped role assignments. A policy row hosts
 * security flags keyed by that same scope id, starting with
 * `ssoRequired`: when true, an admin-staff login whose active admin
 * assignments touch the scope must arrive SSO-asserted or identity
 * refuses the session (403, `code: 'sso_assertion_required'` — see
 * `AUTH_GATE_PROBLEM_CODE` in `auth.schema.ts`).
 *
 * Exposed by service-identity and proxied by the api-gateway at the
 * same paths:
 *
 *   - `GET /api/v1/admin/org-security-policies`
 *     Every policy row (operator-curated, small — single bounded
 *     page, no pagination; same rationale as the role catalog).
 *
 *   - `PUT /api/v1/admin/org-security-policies/:scopeId`
 *     UPSERT — resource-oriented and naturally idempotent: absent
 *     row means "no policy, all flags default-off", so creating and
 *     updating are the same operator gesture.
 *
 * **The `'global'` sentinel.** Global-scoped admin staff
 * (super_admin, finance, …) carry no tenant id; the well-known row
 * `scopeId = 'global'` governs them. It is a valid `:scopeId` on the
 * upsert path — no special-casing on the wire.
 *
 * **Authorisation.** Reads gate on `rbac:read`, the upsert on
 * `rbac:write` (this surface configures who can obtain an admin
 * session — squarely the RBAC-administration trust boundary; no new
 * permission, no seed re-run). Enforced by `PermissionGuard` at both
 * the gateway and service-identity (defence-in-depth).
 *
 * **`.strict()`** everywhere — unknown fields are a parse error.
 */

/** The well-known scope id governing GLOBAL-scoped admin staff. */
export const ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID = 'global';

/** Max length of a scope id (CUID-sized with headroom; matches the assignments surface). */
export const ORG_SECURITY_POLICY_SCOPE_ID_MAX_LENGTH = 64;

/** Max policy rows returned by the list (operator-curated table; bound defeats accidents, not product limits). */
export const ORG_SECURITY_POLICIES_LIST_MAX = 1000;

/**
 * Scope ids are opaque tenant ids (CUID-shaped) or the `'global'`
 * sentinel — a conservative token charset keeps path params and
 * audit lines unambiguous.
 */
export const ORG_SECURITY_POLICY_SCOPE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const OrgSecurityPolicyScopeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(ORG_SECURITY_POLICY_SCOPE_ID_MAX_LENGTH)
  .regex(ORG_SECURITY_POLICY_SCOPE_ID_PATTERN);

/** One policy row as served to admin surfaces. */
export const OrgSecurityPolicyRecordSchema = z
  .object({
    id: z.string().min(1).max(64),
    scopeId: OrgSecurityPolicyScopeIdSchema,
    ssoRequired: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OrgSecurityPolicyRecord = z.infer<typeof OrgSecurityPolicyRecordSchema>;

/** Response body for `GET /api/v1/admin/org-security-policies`. */
export const OrgSecurityPoliciesListResponseSchema = z
  .object({
    policies: z.array(OrgSecurityPolicyRecordSchema).max(ORG_SECURITY_POLICIES_LIST_MAX),
  })
  .strict();
export type OrgSecurityPoliciesListResponse = z.infer<typeof OrgSecurityPoliciesListResponseSchema>;

/**
 * Body for `PUT /api/v1/admin/org-security-policies/:scopeId`.
 * Full-resource PUT: every flag is required, so a replayed or
 * concurrent upsert converges on the same row state.
 */
export const UpsertOrgSecurityPolicyRequestSchema = z
  .object({
    ssoRequired: z.boolean(),
  })
  .strict();
export type UpsertOrgSecurityPolicyRequest = z.infer<typeof UpsertOrgSecurityPolicyRequestSchema>;

/** Policy envelope (`{ policy }`) returned by the upsert. */
export const OrgSecurityPolicyResponseSchema = z
  .object({
    policy: OrgSecurityPolicyRecordSchema,
  })
  .strict();
export type OrgSecurityPolicyResponse = z.infer<typeof OrgSecurityPolicyResponseSchema>;
