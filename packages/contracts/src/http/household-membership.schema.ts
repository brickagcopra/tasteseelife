import { z } from 'zod';

/**
 * Household membership — the internal seam that lets the api-gateway
 * establish a request's household tenant scope (CLAUDE.md §3.2).
 *
 * **Why this contract exists.** Every access token the platform issues
 * carries `tenantScope: {type:'global'}` — `TokenService.signAccessToken`
 * defaults it and no caller has ever set it (TS-505d2-followup-5). Meanwhile
 * thirteen route handlers across service-booking, service-concierge and
 * service-trust-safety resolve the acting household **from the token's
 * scope and refuse a body-supplied household id**, because that asymmetry
 * IS the trust boundary (TS-301a). The result: the family dashboard,
 * wellness trends, wellness anomalies, concierge tickets / onboarding /
 * enrichment / emergency / assignments, and "report a concern" could not be
 * used by any real user.
 *
 * **Why the gateway resolves it and not service-identity.** Household
 * membership lives in `household.household_members`, owned by
 * service-household; §2.3 forbids service-identity reading another
 * service's schema, and §2.3 names gateway aggregation as the sanctioned
 * synchronous cross-service read. Two further reasons the gateway is the
 * right layer rather than the token:
 *
 *   - **Freshness.** A scope baked into a 15-minute access token keeps a
 *     revoked membership alive for up to 15 minutes. A tenant boundary is
 *     exactly the thing that must not go stale for a quarter of an hour.
 *   - **Coverage.** The gateway already recovers the actor once and signs
 *     it into the `x-ts-trust-*` envelope every downstream consumes, so a
 *     single enrichment point covers all thirteen handlers — no per-route
 *     sweep to miss one, which is the failure mode CLAUDE.md warns about.
 *
 * **"Active" means `removed_at IS NULL`** and nothing else. That is the
 * predicate nine existing service-household call sites already use
 * unanimously (`HouseholdAccessService`, `IntakeService`,
 * `SeniorsDirectoryService`, …). Notably it does **not** require
 * `accepted_at` — an invited-but-unaccepted member is treated as a member
 * everywhere on the platform today, and inventing a second, stricter
 * definition here would mean a user could read a household through
 * `/api/v1/me/seniors` while the gateway refused to scope them to it.
 * If that predicate should tighten, it must tighten in all ten places at
 * once.
 */
export const HouseholdMemberRoleSchema = z.enum([
  'primary_payer',
  'family_observer',
  'senior_user',
]);
export type HouseholdMemberRole = z.infer<typeof HouseholdMemberRoleSchema>;

/**
 * One active membership. `memberRole` is carried even though scope
 * resolution does not branch on it: the gateway logs it, and the family /
 * observer distinction is what CLAUDE.md §12's "family observability
 * boundaries" rule turns on downstream. Nothing else about the household
 * crosses this wire — no name, no senior, no address. This response's sole
 * job is to answer "which households may this user act in".
 */
export const HouseholdMembershipSchema = z
  .object({
    householdId: z.string().min(1),
    memberRole: HouseholdMemberRoleSchema,
  })
  .strict();
export type HouseholdMembership = z.infer<typeof HouseholdMembershipSchema>;

/**
 * Upper bound on the memberships returned for one user. A person paying
 * for two parents is the shape the product expects; a hundred is either a
 * data defect or an enumeration attempt, and an unbounded response on a
 * per-request hot path is a denial-of-service surface. The service caps
 * the query and the schema refuses anything longer, so a breach is a 502
 * at the gateway rather than a slow, silently-truncated authorisation
 * decision.
 */
export const HOUSEHOLD_MEMBERSHIPS_MAX = 50;

/**
 * Internal endpoint response — `GET /api/v1/internal/users/:userId/household-memberships`
 * on service-household. Pinned by a shared-secret header, exactly like
 * `InternalSeniorPrepSnapshotResponseSchema`'s route.
 *
 * An unknown user returns `200` with an empty list, not a `404`: the caller
 * is asking "which households may this user act in", and "none" is a
 * complete, correct answer. A 404 would be indistinguishable from a
 * renamed route (the same reasoning TS-509b1's export slice records).
 */
export const InternalHouseholdMembershipsResponseSchema = z
  .object({
    memberships: z.array(HouseholdMembershipSchema).max(HOUSEHOLD_MEMBERSHIPS_MAX),
  })
  .strict();
export type InternalHouseholdMembershipsResponse = z.infer<
  typeof InternalHouseholdMembershipsResponseSchema
>;

// ─── household → billing contacts batch (TS-042-followup-3a1) ───────────

/**
 * Upper bound on the households resolvable in one billing-contacts batch.
 * Sized for a worker or consumer draining a queue of billing events, not
 * for enumeration — the same posture as
 * `WELLNESS_SUMMARY_RECIPIENT_BATCH_MAX`, which this route chains into.
 */
export const HOUSEHOLD_BILLING_CONTACT_BATCH_MAX = 200;

/**
 * Upper bound on primary payers returned for ONE household. The data model
 * permits more than one (there is no unique index on
 * `(household_id, member_role)`), and a couple sharing responsibility for a
 * parent's care is a legitimate shape. A hundred is a data defect.
 */
export const HOUSEHOLD_PRIMARY_PAYERS_MAX = 10;

/**
 * Request body for `POST /api/v1/internal/households/billing-contacts` on
 * service-household.
 */
export const InternalHouseholdBillingContactsRequestSchema = z
  .object({
    householdIds: z.array(z.string().min(1)).min(1).max(HOUSEHOLD_BILLING_CONTACT_BATCH_MAX),
  })
  .strict();
export type InternalHouseholdBillingContactsRequest = z.infer<
  typeof InternalHouseholdBillingContactsRequestSchema
>;

/**
 * The billing contacts for one household: the `userId` of every active
 * `primary_payer` member.
 *
 * **`payerUserIds` is an ARRAY, and that is the design.** The obvious
 * shape — a single `payerUserId` — would require this service to pick one
 * of several payers, and the pick would be invisible to the caller: the
 * second payer on a shared account would simply never be told their card
 * failed, with nothing anywhere recording that a choice had been made.
 * Returning all of them moves the decision to the caller, who knows what
 * the message is (a payment failure warrants telling every payer; a
 * receipt might not).
 *
 * **Payers only.** `family_observer` and `senior_user` members are
 * deliberately excluded, not filtered by the caller. A senior learning by
 * email that their care is about to lapse for non-payment is a dignity
 * failure (CLAUDE.md §12), and the safest place to enforce that is the
 * route that would otherwise hand out their user id.
 *
 * **No addresses, no names.** This route answers "who pays", not "how do I
 * reach them" — emails live in `identity.users` and are resolved by the
 * existing `POST /api/v1/internal/identity/recipient-contacts` hop. Keeping
 * the two apart means neither route alone yields a mailable identity.
 */
export const HouseholdBillingContactSchema = z
  .object({
    householdId: z.string().min(1),
    payerUserIds: z.array(z.string().min(1)).min(1).max(HOUSEHOLD_PRIMARY_PAYERS_MAX),
  })
  .strict();
export type HouseholdBillingContact = z.infer<typeof HouseholdBillingContactSchema>;

/**
 * Response body for the billing-contacts batch.
 *
 * **A household with no active primary payer is ABSENT from `contacts`,
 * never a row with an empty array.** The two states are not the same
 * question — "nobody pays for this household" is an escalation for a human,
 * whereas an empty array reads at a glance like a successful resolution
 * that happened to find nobody. Mirrors the identity recipient-contacts
 * precedent, where an unknown userId is likewise simply absent. The `.min(1)`
 * on `payerUserIds` is what makes the empty-row shape unrepresentable.
 */
export const InternalHouseholdBillingContactsResponseSchema = z
  .object({
    contacts: z.array(HouseholdBillingContactSchema).max(HOUSEHOLD_BILLING_CONTACT_BATCH_MAX),
  })
  .strict();
export type InternalHouseholdBillingContactsResponse = z.infer<
  typeof InternalHouseholdBillingContactsResponseSchema
>;

/**
 * The header a client uses to say **which** household it is acting in.
 *
 * Resolution rules, and why each is what it is:
 *
 *   - **Header present** → the gateway checks it against the caller's own
 *     active memberships and scopes the request to it, or refuses with
 *     `403`. A user can never obtain a scope for a household they do not
 *     belong to; that is the security property this whole seam exists for.
 *   - **Header absent, exactly one active membership** → resolved
 *     automatically. This is the overwhelming majority of accounts, and it
 *     means every existing portal keeps working with no client change.
 *   - **Header absent, more than one membership** → the scope is left
 *     `global` and the household-scoped route refuses the request naming
 *     this header. Picking the first membership would silently act on the
 *     wrong parent's household, which is the one outcome worth failing for.
 *   - **Header absent, no memberships** → `global`, exactly as today.
 *
 * A header rather than a body field, because it must work identically on
 * `GET` and `POST` and must not appear in thirteen request contracts as a
 * field a service might be tempted to trust.
 */
export const HOUSEHOLD_SCOPE_HEADER = 'x-household-id';
