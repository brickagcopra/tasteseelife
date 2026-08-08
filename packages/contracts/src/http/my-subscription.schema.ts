import { z } from 'zod';

import { BillingIntervalSchema, SubscriptionStatusSchema } from './subscription.schema';
import { PlanCurrencySchema } from './plan.schema';

/**
 * The family-facing view of one's own membership
 * (TS-042-followup-3a3-followup-1a).
 *
 * **Nothing on this platform let a family see their own plan.** They
 * could buy one at checkout and then never see it again: the only
 * subscription reads were the admin detail and an internal-id lookup,
 * and neither is reachable from the family portal. So a family in
 * dunning met the emails and the billing page with no way to learn what
 * they were paying for, when it renews, or that anything was wrong.
 *
 * **This is deliberately NOT `SubscriptionResponse`.** That shape is the
 * operator's record and carries things that must not cross to a family:
 *
 *   - **Stripe ids** (`stripeSubscriptionId`, `stripeCustomerId`) —
 *     internal handles to another system's objects. Nothing a family can
 *     do with one is something we want them doing.
 *   - **`dunningAttempts`** — the retry count. It selects the email rung
 *     and never appears in the copy, because "this is our 3rd attempt"
 *     is a collections notice (TS-042-followup-3a3). Putting the number
 *     on a screen would reintroduce exactly what the copy refuses.
 *   - **`pauseReason`** — free text, possibly operator-written *about*
 *     the household. Free text written for one audience does not become
 *     safe by being true.
 *   - **`customerId` / `customerGroup`** — the caller already knows who
 *     they are; echoing the scoping key back teaches its shape.
 *
 * This is the receipt-versus-record split TS-309a made explicit, applied
 * to billing: two views of one row that differ precisely in what may be
 * disclosed.
 *
 * **`paymentTrouble` is a derived boolean, not a raw status.** A family
 * should not have to know that `past_due` and `unpaid` are different
 * words for "your card did not work"; the question they are actually
 * asking is "is something wrong?". `status` is still present for the
 * cases where the distinction is real to them (trialing, paused,
 * canceled), but the trouble flag is what the page leads with.
 */

export const MySubscriptionSummarySchema = z
  .object({
    /**
     * The catalog code. Stable across renames, so it is what a support
     * conversation should quote — but never what a page should render.
     */
    planCode: z.string().min(1).max(64),
    /** The human name from the plan catalog. This is what to render. */
    planName: z.string().min(1).max(200),
    status: SubscriptionStatusSchema,
    billingInterval: BillingIntervalSchema,
    unitPriceUsdMinor: z.number().int().min(0),
    currency: PlanCurrencySchema,
    /**
     * When the current paid period ends — the renewal date, or the last
     * covered day if `cancelAtPeriodEnd` is set. Which of those it means
     * is exactly what `cancelAtPeriodEnd` says, so both travel together.
     */
    currentPeriodEnd: z.string().datetime(),
    trialEnd: z.string().datetime().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    /**
     * True when the platform is having trouble collecting: a failed
     * attempt in this cycle, or a status of `past_due` / `unpaid`.
     * Derived server-side so the portal cannot arrive at a gentler
     * answer than the emails did.
     */
    paymentTrouble: z.boolean(),
    /**
     * The date by which a payment problem needs resolving before visits
     * are paused — `dunningGraceUntil`. Null when there is no trouble.
     * Present because the dunning emails already state this date; a
     * portal that knew it and stayed quiet would be the less honest of
     * the two.
     */
    paymentDueBy: z.string().datetime().nullable(),
    /**
     * When a paused membership resumes collection automatically. Null
     * for an indefinite pause or an unpaused membership. The *reason*
     * for the pause is deliberately absent.
     */
    pauseResumesAt: z.string().datetime().nullable(),
  })
  .strict();
export type MySubscriptionSummary = z.infer<typeof MySubscriptionSummarySchema>;

/**
 * Response for `GET /api/v1/subscriptions/me`.
 *
 * **`subscription: null` is a success, not a 404.** "You have no
 * membership" is a true and useful answer to "what is my membership",
 * and a household that has never subscribed is not an error — it is a
 * household we would like to sell to. A 404 would also force the portal
 * to treat a legitimate state as a failure and render an outage.
 *
 * A wrapper object rather than a bare nullable so the shape can grow
 * (a second membership, a pending change) without a v1 break.
 */
export const MySubscriptionResponseSchema = z
  .object({
    subscription: MySubscriptionSummarySchema.nullable(),
  })
  .strict();
export type MySubscriptionResponse = z.infer<typeof MySubscriptionResponseSchema>;
