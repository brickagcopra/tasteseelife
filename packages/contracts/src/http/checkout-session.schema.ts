import { z } from 'zod';

import { CouponCodeSchema } from './coupon.schema';
import { PlanCustomerGroupSchema } from './plan.schema';
import { BillingIntervalSchema, SUBSCRIPTION_TRIAL_DAYS_MAX } from './subscription.schema';

/**
 * Stripe Checkout Session HTTP DTOs (TS-124).
 *
 * Stripe Checkout is the hosted-page flow: the platform creates a Session
 * with the desired subscription parameters, redirects the customer to
 * Stripe's hosted page, and is told (via the success URL or webhook) when
 * the customer completes payment. Compared to the embedded PaymentIntent
 * flow already implemented in `CreateSubscriptionRequest`, Checkout
 * trades client-side flexibility for PCI surface reduction — the card
 * field never touches our origin (CLAUDE.md §3.5 / §17.1).
 *
 * Three surfaces:
 *
 *   - `POST /api/v1/subscriptions/checkout-sessions` creates a Session
 *     and returns the hosted URL. Idempotent on `Idempotency-Key`.
 *
 *   - `GET  /api/v1/subscriptions/checkout-sessions/:id` reads the
 *     session status from Stripe. Pure read, no side effects.
 *
 *   - `POST /api/v1/subscriptions/checkout-sessions/:id/finalize`
 *     promotes a completed session into a local subscription row.
 *     Idempotent on the session id — replaying after the row exists
 *     returns the existing row.
 *
 * `.strict()` everywhere — unknown fields are a parse error.
 */

/**
 * Stripe Checkout Session status. Mirrors the Stripe SDK enum but only
 * the values that can reach us across the Stripe API. `expired` covers
 * a session whose 24-hour TTL elapsed without completion.
 */
export const CheckoutSessionStatusSchema = z.enum(['open', 'complete', 'expired']);
export type CheckoutSessionStatus = z.infer<typeof CheckoutSessionStatusSchema>;

/**
 * Bound on the customer-facing `successUrl` / `cancelUrl` fields.
 * Generous enough to absorb a query-string redirect chain; tight enough
 * to reject a runaway client header. Stripe itself caps at ~2,048 chars,
 * so we stay well below.
 */
export const CHECKOUT_RETURN_URL_MAX_LENGTH = 1024;

/**
 * URL schema constrained to http/https. Stripe rejects any other scheme
 * at session-create time; we mirror the check here so a bad request
 * doesn't waste a Stripe round-trip.
 */
const ReturnUrlSchema = z
  .string()
  .url()
  .max(CHECKOUT_RETURN_URL_MAX_LENGTH)
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'successUrl/cancelUrl must be an http(s) URL',
  });

/**
 * Create-checkout-session request (POST /api/v1/subscriptions/checkout-sessions).
 *
 *   - `planId`           catalog plan id (`plans.id`).
 *   - `customerId`       soft FK into household / provider / users
 *                        depending on the plan's `customerGroup`.
 *   - `customerGroup`    discriminator for `customerId`. Validated
 *                        against the plan's `customerGroup` server-side.
 *   - `customerEmail`    used to create a Stripe Customer when one does
 *                        not exist yet. Once created, `cus_...` is cached
 *                        and re-used.
 *   - `customerName`     optional Stripe Customer display name.
 *   - `billingInterval`  monthly vs annual.
 *   - `trialDays`        optional trial length.
 *   - `couponCode`       optional promo code. Validated + (lazy-)created
 *                        on Stripe before the Session is created so a
 *                        failing coupon never produces a Stripe artifact.
 *   - `successUrl`       Stripe redirects here after successful payment.
 *                        The portal embeds `?session_id={CHECKOUT_SESSION_ID}`
 *                        and looks the session up on landing.
 *   - `cancelUrl`        Stripe redirects here if the customer cancels.
 *
 * No `paymentMethodId` — that's the embedded-flow input. With Checkout,
 * Stripe collects the payment method on the hosted page.
 */
export const CreateCheckoutSessionRequestSchema = z
  .object({
    planId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
    customerGroup: PlanCustomerGroupSchema,
    customerEmail: z.string().email().max(254),
    customerName: z.string().min(1).max(160).optional(),
    billingInterval: BillingIntervalSchema,
    trialDays: z.number().int().min(0).max(SUBSCRIPTION_TRIAL_DAYS_MAX).optional(),
    couponCode: CouponCodeSchema.optional(),
    successUrl: ReturnUrlSchema,
    cancelUrl: ReturnUrlSchema,
  })
  .strict();
export type CreateCheckoutSessionRequest = z.infer<typeof CreateCheckoutSessionRequestSchema>;

/**
 * Response from `POST /api/v1/subscriptions/checkout-sessions` —
 * just enough for the portal to redirect.
 *
 *   - `id`         Stripe Checkout Session id (`cs_...`). The portal
 *                  needs this on the success page to fetch the final
 *                  session state.
 *   - `url`        hosted Stripe URL the portal redirects the customer
 *                  to. The portal does NOT render this in HTML — it
 *                  issues a server-side redirect so the URL never lands
 *                  in browser history.
 *   - `expiresAt`  when the session expires. Stripe's default is 24h
 *                  from creation.
 *   - `status`     always `'open'` on first create. Echoed for parity
 *                  with the GET response shape.
 */
export const CreateCheckoutSessionResponseSchema = z
  .object({
    id: z.string().min(1).max(120),
    url: z.string().url().max(2048),
    expiresAt: z.string().datetime(),
    status: CheckoutSessionStatusSchema,
  })
  .strict();
export type CreateCheckoutSessionResponse = z.infer<typeof CreateCheckoutSessionResponseSchema>;

/**
 * Response from `GET /api/v1/subscriptions/checkout-sessions/:id` —
 * read-side view of a session.
 *
 *   - When `status === 'complete'` the response also carries
 *     `stripeSubscriptionId` (the `sub_...` Stripe created during
 *     payment confirmation) and optionally `subscriptionId` (the local
 *     row id, populated once finalize has run).
 *
 *   - The portal uses this on the success page to decide whether the
 *     payment has actually cleared (Stripe doesn't redirect until
 *     payment_status === 'paid' or 'no_payment_required' for subscription
 *     mode, but defensive code re-checks here).
 *
 *   - `url` is included even after completion so the portal can show a
 *     "view receipt" link without a second API call.
 */
export const GetCheckoutSessionResponseSchema = z
  .object({
    id: z.string().min(1).max(120),
    url: z.string().url().max(2048),
    expiresAt: z.string().datetime(),
    status: CheckoutSessionStatusSchema,
    /**
     * Stripe subscription id created by the Checkout flow. Null when
     * status is `open` or `expired`. Populated when status is `complete`.
     */
    stripeSubscriptionId: z.string().min(1).max(64).nullable(),
    /**
     * Local subscription row id. Null until `finalize` has run.
     * Populated when a `subscriptions.id` exists for the
     * stripe-side subscription.
     */
    subscriptionId: z.string().min(1).max(64).nullable(),
    /**
     * Customer-supplied email captured by Stripe at checkout time.
     * Echoed so the portal can show "we sent your receipt to ...".
     * Null when status is `open` (no payment yet).
     */
    customerEmail: z.string().email().max(254).nullable(),
  })
  .strict();
export type GetCheckoutSessionResponse = z.infer<typeof GetCheckoutSessionResponseSchema>;

/**
 * Finalize-checkout-session request (POST .../checkout-sessions/:id/finalize).
 *
 * The session id rides in the URL. Empty body — but kept as a typed Zod
 * object so the gateway proxy can validate "this is a valid empty body"
 * (rejecting a stray JSON payload) and so future fields (e.g. an
 * operator-supplied `note` for admin tooling) can be added without
 * a contract break.
 */
export const FinalizeCheckoutSessionRequestSchema = z.object({}).strict();
export type FinalizeCheckoutSessionRequest = z.infer<typeof FinalizeCheckoutSessionRequestSchema>;
