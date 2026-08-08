import { z } from 'zod';

/**
 * Provider → owning-account resolution for billing notifications
 * (TS-042-followup-3a1a).
 *
 * **The gap this closes.** `subscriptions.customer_id`'s referent depends on
 * `customer_group` (TS-042-followup-3a2a): for `family` it is a household id,
 * for `provider` it is a `provider.providers.id`. TS-042-followup-3a1 built
 * the household half, so a family whose card fails gets the dunning ladder.
 * A PROVIDER whose card fails got `skipped_customer_group` — a WARN, and
 * nobody told. This is the missing hop.
 *
 * **It is a resolver, not a copy of the household one, and the difference is
 * in the schema.** `provider.providers.user_id` is `@unique` — at most one
 * provider profile per identity user, enforced at the database. So this route
 * returns a single `ownerUserId`, where the household route returns an ARRAY
 * of `payerUserIds` because a household genuinely can have several payers and
 * picking one would silently drop the other. Mirroring the array here would
 * assert a plurality the schema forbids. **If provider ownership ever becomes
 * multi-user, this field must become an array AND every caller revisited** —
 * widening it silently would recreate exactly the bug the household array
 * exists to prevent.
 *
 * **No status filter, deliberately.** Every existing provider row resolves,
 * including `suspended`, `archived` and soft-deleted ones. A provider whose
 * profile is archived can still hold a live subscription, and the whole point
 * of this route is that a failing card reaches the person paying for it —
 * filtering here would make exactly that customer unreachable while looking
 * like a clean empty result. Deliverability is already decided one hop later
 * by `POST /api/v1/internal/identity/recipient-contacts`, which screens for an
 * active account and yields the named `no_deliverable_contact` outcome; two
 * places deciding it is two places to be wrong.
 *
 * **No addresses, no names, no display name.** Same split as the household
 * route: this answers "whose account is this", not "how do I reach them", so
 * neither route alone yields a mailable identity.
 */

/**
 * Upper bound on providers resolvable in one batch. Matches
 * `HOUSEHOLD_BILLING_CONTACT_BATCH_MAX` — the two feed the same consumer and
 * chain into the same `recipient-contacts` cap, so a different number here
 * would only be a number to get wrong.
 */
export const PROVIDER_BILLING_CONTACT_BATCH_MAX = 200;

export const InternalProviderBillingContactsRequestSchema = z
  .object({
    providerIds: z.array(z.string().min(1)).min(1).max(PROVIDER_BILLING_CONTACT_BATCH_MAX),
  })
  .strict();
export type InternalProviderBillingContactsRequest = z.infer<
  typeof InternalProviderBillingContactsRequestSchema
>;

/**
 * The owning account for one provider.
 *
 * `ownerUserId` is singular because `providers.user_id` is `@unique` — see
 * the module doc-block for why that is a contract decision and not a
 * convenience.
 */
export const ProviderBillingContactSchema = z
  .object({
    providerId: z.string().min(1),
    ownerUserId: z.string().min(1),
  })
  .strict();
export type ProviderBillingContact = z.infer<typeof ProviderBillingContactSchema>;

/**
 * Response body for the batch.
 *
 * **A provider id that matches no row is ABSENT from `contacts`**, never a
 * row with a null owner. The two are different questions — "no such provider"
 * is a stale or wrong id in the subscription, which is an escalation for a
 * human — and a nullable field would let a caller iterate past it. A response
 * shorter than the request is therefore a real signal, exactly as on the
 * household route.
 */
export const InternalProviderBillingContactsResponseSchema = z
  .object({
    contacts: z.array(ProviderBillingContactSchema).max(PROVIDER_BILLING_CONTACT_BATCH_MAX),
  })
  .strict();
export type InternalProviderBillingContactsResponse = z.infer<
  typeof InternalProviderBillingContactsResponseSchema
>;
