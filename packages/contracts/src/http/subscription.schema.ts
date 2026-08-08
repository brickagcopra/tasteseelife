import { z } from 'zod';

import { CouponCodeSchema } from './coupon.schema';
import { PlanCurrencySchema, PlanCustomerGroupSchema } from './plan.schema';

/**
 * Subscription HTTP DTOs (PRD §5, §6.2; PDD §11.1; CLAUDE.md §3.3, §6).
 *
 * The single source of truth for the public contract of `service-subscription`'s
 * `POST /api/v1/subscriptions`, `PATCH /api/v1/subscriptions/:id`, and
 * `DELETE /api/v1/subscriptions/:id` endpoints. The subscription-svc backend
 * and any web client / BFF derive their input validators and response types
 * from this module.
 *
 * `.strict()` everywhere — unknown fields are a parse error so a typo or a
 * stray client field never silently round-trips (CLAUDE.md §3.3 "Reject
 * unknown fields by default").
 */

/**
 * Subscription lifecycle status. Mirrors the `subscription_status` Prisma
 * enum in `apps/service-subscription/prisma/schema.prisma` (TS-041b).
 *
 * - `incomplete`         — created but the first payment hasn't cleared.
 * - `incomplete_expired` — first payment never cleared in time.
 * - `trialing`           — inside a trial period (no charges yet).
 * - `active`             — paid + within the current period.
 * - `past_due`           — payment failed; in dunning grace period.
 * - `unpaid`             — dunning exhausted; no service.
 * - `canceled`           — terminated. May still have access until
 *                          `currentPeriodEnd` if cancel-at-period-end was set.
 * - `paused`             — admin-suspended (PRD §10.3 pause/resume).
 *
 * Adding a new status is a breaking-but-explicit contract change rather
 * than a silent extension.
 */
export const SubscriptionStatusSchema = z.enum([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
  'paused',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

/**
 * Billing interval — monthly vs annual. Frozen on the subscription row at
 * creation; changing the interval requires creating a new subscription.
 */
export const BillingIntervalSchema = z.enum(['monthly', 'annual']);
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;

/**
 * Categorical reason a subscription was canceled. Matches the
 * `subscription.canceled` event payload (`SubscriptionCanceledSchema.reason`)
 * one-for-one — kept in sync deliberately so the event payload can be
 * derived from the persisted row without a translation table.
 */
export const SubscriptionCancelReasonSchema = z.enum([
  'customer_request',
  'payment_failure',
  'fraud',
  'admin_action',
  'partner_termination',
]);
export type SubscriptionCancelReason = z.infer<typeof SubscriptionCancelReasonSchema>;

/**
 * Maximum trial-day count accepted at subscription create time. Stripe
 * supports up to 730 days; product policy is "trials are at most a quarter".
 * Lower cap = lower blast radius if a client typoes the field.
 */
export const SUBSCRIPTION_TRIAL_DAYS_MAX = 90;

/**
 * Idempotency-Key header bounds. The header is opaque to us — we propagate
 * to Stripe as their idempotency-key (Stripe enforces ≤ 255 chars) and stash
 * in our own Redis cache once TS-044 lands. Caps here are the contract's
 * defence-in-depth against a runaway client header.
 */
export const SUBSCRIPTION_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const SUBSCRIPTION_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/**
 * Create-subscription request (POST /api/v1/subscriptions).
 *
 * The caller specifies:
 *   - `planId`             — the catalog plan id (`plans.id`).
 *   - `customerId`         — soft FK into household / provider / users
 *                            depending on the plan's `customerGroup`.
 *                            Validated server-side against the caller's
 *                            permissions (the family-payer can only
 *                            subscribe their household; admin tooling
 *                            can override).
 *   - `customerGroup`      — discriminator for the `customerId` referent.
 *                            Must match the plan's `customerGroup` — the
 *                            service rejects with 400 on mismatch.
 *   - `billingInterval`    — monthly vs annual.
 *   - `paymentMethodId`    — Stripe `pm_...` id from the client's
 *                            Stripe Elements / Checkout flow. Optional
 *                            for trial subscriptions; required otherwise.
 *   - `trialDays`          — optional trial length in days
 *                            (0 ≤ n ≤ SUBSCRIPTION_TRIAL_DAYS_MAX).
 *   - `customerEmail`      — used to create a Stripe Customer when one
 *                            does not exist for `customerId` yet. The
 *                            service caches `cus_...` after the first
 *                            create so subsequent subscriptions reuse it.
 *   - `customerName`       — optional human-readable name on the Stripe
 *                            Customer record.
 */
export const CreateSubscriptionRequestSchema = z
  .object({
    planId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
    customerGroup: PlanCustomerGroupSchema,
    billingInterval: BillingIntervalSchema,
    paymentMethodId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^pm_/, 'paymentMethodId must be a Stripe pm_... identifier')
      .optional(),
    trialDays: z.number().int().min(0).max(SUBSCRIPTION_TRIAL_DAYS_MAX).optional(),
    customerEmail: z.string().email().max(254),
    customerName: z.string().min(1).max(160).optional(),
    /**
     * Optional promo code to apply at checkout (TS-043). The service
     * validates the code against the plan + customer + first-time-only
     * gate, lazy-creates a Stripe Coupon for `percent_off` / `amount_off`
     * kinds, and persists a `coupon_redemptions` row in the same
     * Prisma transaction that creates the subscription. For
     * `extended_trial` kinds, the trial-day extension is added to
     * `trialDays` before the Stripe call. Validation failure returns
     * a 400 with a body that names the failing rule (`coupon_expired`,
     * `coupon_plan_not_eligible`, etc.) — never a generic message,
     * because the family-portal needs to surface the reason to the
     * customer.
     */
    couponCode: CouponCodeSchema.optional(),
  })
  .strict()
  .refine((data) => data.trialDays !== undefined || data.paymentMethodId !== undefined, {
    message: 'paymentMethodId is required unless trialDays is set',
    path: ['paymentMethodId'],
  });
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

/**
 * Patch-subscription request (PATCH /api/v1/subscriptions/:id).
 *
 * Two mutation kinds, exclusive at the wire (cannot patch both in the
 * same request — would otherwise create ambiguity about the intended
 * proration behaviour):
 *   - `planId`           — switch the subscription to a new plan.
 *                          Triggers a Stripe proration; the next invoice
 *                          carries a credit/charge line for the unused
 *                          portion of the old plan.
 *   - `paymentMethodId`  — replace the default payment method. Does NOT
 *                          re-attempt failed invoices automatically;
 *                          callers wanting that should also POST to the
 *                          dunning resume endpoint (TS-042).
 *
 * Both fields are optional individually; the controller-side `.refine()`
 * enforces that at least one is provided so a client that sends `{}` is a
 * 400, not a no-op success.
 */
export const PatchSubscriptionRequestSchema = z
  .object({
    planId: z.string().min(1).max(64).optional(),
    paymentMethodId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^pm_/, 'paymentMethodId must be a Stripe pm_... identifier')
      .optional(),
  })
  .strict()
  .refine((data) => data.planId !== undefined || data.paymentMethodId !== undefined, {
    message: 'patch must include at least one of planId or paymentMethodId',
  });
export type PatchSubscriptionRequest = z.infer<typeof PatchSubscriptionRequestSchema>;

/**
 * Cancel-subscription request body (DELETE /api/v1/subscriptions/:id).
 *
 * Why a body on DELETE: the cancel-at-period-end vs immediately decision
 * is mutation policy that survives a retry, so it has to ride with the
 * request. RFC 7231 §4.3.5 explicitly permits a body on DELETE for this
 * purpose; the OpenAPI generator emits it as `requestBody`.
 *
 * `reason` is a categorical signal for analytics + the canceled event;
 * `note` is operator-supplied free text (admin tooling) capped at 2000
 * chars, never echoed back to the customer.
 */
export const CancelSubscriptionRequestSchema = z
  .object({
    cancelAtPeriodEnd: z.boolean().default(true),
    reason: SubscriptionCancelReasonSchema.default('customer_request'),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type CancelSubscriptionRequest = z.infer<typeof CancelSubscriptionRequestSchema>;

/**
 * Pause-subscription request body (POST /api/v1/subscriptions/:id/pause) —
 * TS-042 admin/customer-initiated pause that maps to Stripe's
 * `pause_collection: { behavior: 'void', resumes_at? }`.
 *
 *  - `resumesAt`  optional ISO datetime in the future; if set, Stripe
 *                 resumes collection automatically at that instant. If
 *                 omitted, the pause is indefinite until an explicit
 *                 `/resume` call.
 *  - `reason`     free-form operator/customer-supplied context. Capped
 *                 at `PAUSE_REASON_MAX_LENGTH` chars and persisted in
 *                 `subscriptions.pause_reason`. Never echoed back to the
 *                 customer outside admin tooling.
 */
export const PAUSE_REASON_MAX_LENGTH = 500;

export const PauseSubscriptionRequestSchema = z
  .object({
    resumesAt: z.string().datetime().optional(),
    reason: z.string().min(1).max(PAUSE_REASON_MAX_LENGTH).optional(),
  })
  .strict();
export type PauseSubscriptionRequest = z.infer<typeof PauseSubscriptionRequestSchema>;

/**
 * Resume-subscription request body (POST /api/v1/subscriptions/:id/resume).
 *
 * The handler clears `pause_collection` on the Stripe side and transitions
 * our row back to `active` / `trialing` based on the Stripe response. The
 * optional `note` is operator-supplied free text persisted on the
 * `resumed` history entry (PDD §17.1 audit trail).
 */
export const ResumeSubscriptionRequestSchema = z
  .object({
    note: z.string().max(2000).optional(),
  })
  .strict();
export type ResumeSubscriptionRequest = z.infer<typeof ResumeSubscriptionRequestSchema>;

/**
 * Subscription DTO — the read-back shape returned by every subscription
 * endpoint and (eventually) by `GET /api/v1/subscriptions/:id`.
 *
 * **Money fields**: amounts are integer USD minor units
 * (`unitPriceUsdMinor`) per CLAUDE.md §17.6 — no floats over the wire.
 *
 * **Stripe ids** (`stripeSubscriptionId`, `stripeCustomerId`) are echoed
 * for client-side correlation with Stripe-issued artifacts (the hosted
 * invoice URL, the customer portal link) but the platform's own `id`
 * is the canonical identifier used in every other API surface.
 *
 * **Soft-FK `customerId`** is returned alongside `customerGroup` so the
 * client can look up the household / provider / user it points at via
 * the appropriate service.
 *
 * The DTO deliberately omits the per-row `defaultPaymentMethodId` Prisma
 * column — clients that need payment-method details fetch them via the
 * payment-methods endpoint (lands with TS-127 admin tooling). Today the
 * id is internal to the service.
 */
export const SubscriptionResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    stripeSubscriptionId: z.string().min(1).max(64),
    stripeCustomerId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
    customerGroup: PlanCustomerGroupSchema,
    planId: z.string().min(1).max(64),
    planCode: z.string().min(1).max(64),
    status: SubscriptionStatusSchema,
    billingInterval: BillingIntervalSchema,
    unitPriceUsdMinor: z.number().int().min(0),
    currency: PlanCurrencySchema.default('USD'),
    currentPeriodStart: z.string().datetime(),
    currentPeriodEnd: z.string().datetime(),
    trialEnd: z.string().datetime().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    cancelReason: SubscriptionCancelReasonSchema.nullable(),
    canceledAt: z.string().datetime().nullable(),
    /**
     * TS-042 dunning state — Stripe-driven retry count this billing
     * cycle. Resets to 0 on `recordPaymentSuccess` (or when the next
     * period begins). 0 for healthy subscriptions.
     */
    dunningAttempts: z.number().int().min(0),
    /**
     * Timestamp of the most recent retry attempt. Null while the
     * subscription has never seen a failed payment in the current cycle.
     */
    dunningLastAttemptAt: z.string().datetime().nullable(),
    /**
     * Deadline after which the dunning exhaustion sweep flips the row
     * from `past_due` to `unpaid`. Stamped on the FIRST failure in a
     * cycle (at `firstFailureAt + DUNNING_GRACE_DAYS`) and preserved
     * through subsequent retry attempts. Null when the subscription has
     * never entered dunning.
     */
    dunningGraceUntil: z.string().datetime().nullable(),
    /**
     * Timestamp the pause was applied (Stripe `pause_collection` set).
     * Null while the subscription has never been paused / is currently
     * active.
     */
    pauseCollectionStartedAt: z.string().datetime().nullable(),
    /**
     * If non-null, Stripe automatically resumes collection at this
     * instant. Null for an indefinite pause.
     */
    pauseCollectionResumesAt: z.string().datetime().nullable(),
    /**
     * Free-form operator/customer-supplied reason captured at pause
     * time. Persisted to `subscriptions.pause_reason`; reset to null on
     * resume.
     */
    pauseReason: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;
