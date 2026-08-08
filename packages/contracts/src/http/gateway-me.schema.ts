import { z } from 'zod';

/**
 * Response shape for `GET /api/v1/me` on the api-gateway (TS-140).
 *
 * Derived entirely from the verified access token's `RequestContext` —
 * the gateway does NOT call a downstream service to construct this
 * response. This makes `/me` the cheapest possible authenticated read
 * (no service hops, no rate-limited Postgres reads) — load-bearing for
 * the family-portal nav-bar that fetches it on every route change.
 *
 * Three downstream-derived enrichments (name, email, phone — owned by
 * service-identity; household memberships — owned by service-household)
 * land via dedicated endpoints (`GET /api/v1/users/me/profile`,
 * `GET /api/v1/users/me/households`) that the portal calls in parallel
 * when it needs the richer view. Splitting the cheap-actor-id surface
 * from the expensive-profile surface keeps the most common read on
 * the fastest path.
 */
const ME_USER_ID_MAX_LENGTH = 64;
const ME_SESSION_ID_MAX_LENGTH = 64;
const ME_ROLE_NAME_MAX_LENGTH = 64;
const ME_PERMISSION_MAX_LENGTH = 128;
const ME_TENANT_ID_MAX_LENGTH = 64;
const ME_HOUSEHOLD_ID_MAX_LENGTH = 64;

export const MeRoleAssignmentSchema = z
  .object({
    name: z.string().min(1).max(ME_ROLE_NAME_MAX_LENGTH),
    permissions: z.array(z.string().min(1).max(ME_PERMISSION_MAX_LENGTH)),
    scope: z.discriminatedUnion('type', [
      z.object({ type: z.literal('global') }).strict(),
      z
        .object({
          type: z.literal('tenant'),
          tenantId: z.string().min(1).max(ME_TENANT_ID_MAX_LENGTH),
        })
        .strict(),
      z
        .object({
          type: z.literal('household'),
          householdId: z.string().min(1).max(ME_HOUSEHOLD_ID_MAX_LENGTH),
        })
        .strict(),
    ]),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export type MeRoleAssignment = z.infer<typeof MeRoleAssignmentSchema>;

export const MeTenantScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('global') }).strict(),
  z
    .object({
      type: z.literal('tenant'),
      tenantId: z.string().min(1).max(ME_TENANT_ID_MAX_LENGTH),
    })
    .strict(),
  z
    .object({
      type: z.literal('household'),
      householdId: z.string().min(1).max(ME_HOUSEHOLD_ID_MAX_LENGTH),
    })
    .strict(),
]);
export type MeTenantScope = z.infer<typeof MeTenantScopeSchema>;

/**
 * One household the actor may act in (TS-505d2-followup-5a).
 *
 * Structurally the same as `HouseholdMembershipSchema` in
 * `household-membership.schema.ts` and deliberately NOT a re-export of it.
 * That one is the internal wire format between the gateway and
 * service-household; this one is a public, family-portal-facing field on
 * `/api/v1/me`. Collapsing them would mean a future change to the internal
 * projection silently changed a published response — the same reason
 * `ReportConcernReceiptSchema` is not the incident record.
 */
export const MeHouseholdMembershipSchema = z
  .object({
    householdId: z.string().min(1).max(ME_HOUSEHOLD_ID_MAX_LENGTH),
    memberRole: z.enum(['primary_payer', 'family_observer', 'senior_user']),
  })
  .strict();
export type MeHouseholdMembership = z.infer<typeof MeHouseholdMembershipSchema>;

export const MeResponseSchema = z
  .object({
    userId: z.string().min(1).max(ME_USER_ID_MAX_LENGTH),
    sessionId: z.string().min(1).max(ME_SESSION_ID_MAX_LENGTH).nullable(),
    mfaVerified: z.boolean(),
    /**
     * Present ONLY on impersonation sessions (TS-297): the operator's
     * user id, mirrored from the access token's `actorOnBehalfOf`
     * claim. `userId` is the impersonated user. Portals render the
     * "Impersonating …" label when this field is present.
     */
    actorOnBehalfOf: z.string().min(1).max(ME_USER_ID_MAX_LENGTH).optional(),
    roles: z.array(MeRoleAssignmentSchema),
    tenantScope: MeTenantScopeSchema,
    /**
     * Every household this actor may act in (TS-505d2-followup-5a).
     *
     * **`tenantScope` says which household the request is acting in;
     * this says which ones it COULD.** They are different questions and
     * the portal needs both: with one membership the scope resolves
     * automatically and no picker is shown, and with several the scope
     * stays `global` until the client names one with the
     * `X-Household-Id` header — so without this list the portal has
     * nothing to render the choice from and the user is stuck at a 400
     * that tells them to send a header they cannot construct.
     *
     * Always present, `[]` for staff, providers and partner users, who
     * are the common case. Not `.optional()`: an absent field and an
     * empty list would be indistinguishable to a client deciding
     * whether to show a picker, and "this actor belongs to no
     * household" is a real answer rather than a missing one.
     *
     * Carries household ids and member roles only — no names, no
     * seniors, no addresses. The portal renders the choice; the
     * household's own surfaces render the household.
     */
    households: z.array(MeHouseholdMembershipSchema),
  })
  .strict();
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const ME_USER_ID_MAX_LENGTH_EXPORT = ME_USER_ID_MAX_LENGTH;
export const ME_SESSION_ID_MAX_LENGTH_EXPORT = ME_SESSION_ID_MAX_LENGTH;
export const ME_ROLE_NAME_MAX_LENGTH_EXPORT = ME_ROLE_NAME_MAX_LENGTH;
export const ME_PERMISSION_MAX_LENGTH_EXPORT = ME_PERMISSION_MAX_LENGTH;
export const ME_TENANT_ID_MAX_LENGTH_EXPORT = ME_TENANT_ID_MAX_LENGTH;
export const ME_HOUSEHOLD_ID_MAX_LENGTH_EXPORT = ME_HOUSEHOLD_ID_MAX_LENGTH;
