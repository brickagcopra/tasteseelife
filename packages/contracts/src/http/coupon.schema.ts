import { z } from 'zod';

import { PlanCustomerGroupSchema } from './plan.schema';

/**
 * Coupon HTTP DTOs (TS-043; PRD §10.4; CLAUDE.md §12 coupon-abuse policy).
 *
 * The single source of truth for the public contract of
 * `service-subscription`'s coupon endpoints:
 *
 *   POST   /api/v1/coupons/validate       — public: rate-limited preview
 *   POST   /api/v1/admin/coupons          — admin: create a new coupon
 *   DELETE /api/v1/admin/coupons/:id      — admin: deactivate
 *
 * `.strict()` everywhere — unknown fields are a parse error so a typo
 * or a stray client field never silently round-trips (CLAUDE.md §3.3).
 */

/**
 * Discount mechanism. Mirrors the Prisma enum 1:1.
 *
 *  - `percent_off`     — `amount` is the percent (1–100). Stripe-backed.
 *  - `amount_off`      — `amount` is the discount in `currency` minor
 *                        units. Stripe-backed.
 *  - `extended_trial`  — `amount` is the number of trial days to add to
 *                        the inaugural subscription. Bypasses Stripe.
 */
export const CouponKindSchema = z.enum(['percent_off', 'amount_off', 'extended_trial']);
export type CouponKind = z.infer<typeof CouponKindSchema>;

/** Discount duration. Mirrors Stripe's `Coupon.duration` 1:1. */
export const CouponDurationSchema = z.enum(['once', 'repeating', 'forever']);
export type CouponDuration = z.infer<typeof CouponDurationSchema>;

/** Code character set + length bounds. */
export const COUPON_CODE_MIN_LENGTH = 3;
export const COUPON_CODE_MAX_LENGTH = 32;
export const COUPON_CODE_REGEX = /^[A-Z0-9_-]+$/;

/**
 * Promotional code as a string. Service-layer normalises to upper-case
 * before persistence; the contract only accepts the normalised form so
 * a request that lower-cases the code is a 400, not a silent
 * re-encoding (matches the strict-field-validation discipline).
 */
export const CouponCodeSchema = z
  .string()
  .min(COUPON_CODE_MIN_LENGTH)
  .max(COUPON_CODE_MAX_LENGTH)
  .regex(
    COUPON_CODE_REGEX,
    'coupon code must be upper-case alphanumerics, underscores, or hyphens',
  );

/** Admin-facing free-text bounds. */
export const COUPON_NAME_MAX_LENGTH = 120;
export const COUPON_NOTES_MAX_LENGTH = 2000;

/** Amount bounds per kind (validated post-discriminator). */
export const COUPON_PERCENT_OFF_MIN = 1;
export const COUPON_PERCENT_OFF_MAX = 100;
export const COUPON_AMOUNT_OFF_MIN_MINOR = 1;
/** $1M cap — a coupon worth more than that is almost certainly a typo. */
export const COUPON_AMOUNT_OFF_MAX_MINOR = 100_000_000;
export const COUPON_EXTENDED_TRIAL_MIN_DAYS = 1;
/** Mirrors `SUBSCRIPTION_TRIAL_DAYS_MAX` in subscription.schema.ts. */
export const COUPON_EXTENDED_TRIAL_MAX_DAYS = 90;

/** Cap controls. */
export const COUPON_MAX_REDEMPTIONS_MAX = 10_000_000;
export const COUPON_PER_CUSTOMER_LIMIT_MAX = 1000;
export const COUPON_DURATION_IN_MONTHS_MAX = 36;

/**
 * Coupon DTO — the admin read-back shape for a created / fetched
 * coupon row. The `code` is returned upper-cased per the storage
 * convention.
 *
 * **Validate-coupon flow doesn't return this** — it returns the
 * narrower `ValidateCouponResponse` that omits internal columns
 * (`stripeCouponId`, `notes`, etc.) the public surface shouldn't see.
 */
export const CouponSchema = z
  .object({
    id: z.string().min(1).max(64),
    code: CouponCodeSchema,
    name: z.string().min(1).max(COUPON_NAME_MAX_LENGTH),
    kind: CouponKindSchema,
    amount: z.number().int().min(1),
    currency: z.string().length(3).default('USD'),
    duration: CouponDurationSchema,
    durationInMonths: z.number().int().min(1).max(COUPON_DURATION_IN_MONTHS_MAX).nullable(),
    appliesToPlanIds: z.array(z.string().min(1).max(64)).max(128),
    maxRedemptions: z.number().int().min(1).max(COUPON_MAX_REDEMPTIONS_MAX).nullable(),
    timesRedeemed: z.number().int().min(0),
    perCustomerLimit: z.number().int().min(1).max(COUPON_PER_CUSTOMER_LIMIT_MAX).nullable(),
    firstTimeCustomerOnly: z.boolean(),
    minSpendMinor: z.number().int().min(0).nullable(),
    stackable: z.boolean(),
    expiresAt: z.string().datetime().nullable(),
    active: z.boolean(),
    notes: z.string().max(COUPON_NOTES_MAX_LENGTH).nullable(),
    createdByUserId: z.string().min(1).max(64),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type Coupon = z.infer<typeof CouponSchema>;

/**
 * Create-coupon request (POST /api/v1/admin/coupons).
 *
 * **Why a single schema rather than a discriminated union on `kind`**:
 * the field set is largely shared across kinds (`name`, `currency`,
 * `duration`, eligibility), and the per-kind bounds on `amount` are
 * enforced by a `.superRefine()` that keeps every error in the same
 * Zod issue stream. A discriminated union would explode the front-end
 * type ergonomics for marginal gain.
 *
 * **Code normalisation**: clients SHOULD send upper-case; lower-case
 * + mixed-case requests are rejected at the boundary so the storage
 * representation matches the wire representation.
 */
export const CreateCouponRequestSchema = z
  .object({
    code: CouponCodeSchema,
    name: z.string().min(1).max(COUPON_NAME_MAX_LENGTH),
    kind: CouponKindSchema,
    /**
     * Interpretation depends on `kind`:
     *   - percent_off    → 1–100
     *   - amount_off     → minor units (1 to 100_000_000)
     *   - extended_trial → days (1–90)
     */
    amount: z.number().int(),
    currency: z.string().length(3).default('USD'),
    duration: CouponDurationSchema.default('once'),
    durationInMonths: z.number().int().min(1).max(COUPON_DURATION_IN_MONTHS_MAX).optional(),
    appliesToPlanIds: z.array(z.string().min(1).max(64)).max(128).default([]),
    maxRedemptions: z.number().int().min(1).max(COUPON_MAX_REDEMPTIONS_MAX).optional(),
    perCustomerLimit: z
      .number()
      .int()
      .min(1)
      .max(COUPON_PER_CUSTOMER_LIMIT_MAX)
      .nullable()
      .optional(),
    firstTimeCustomerOnly: z.boolean().default(false),
    minSpendMinor: z.number().int().min(0).optional(),
    stackable: z.boolean().default(false),
    expiresAt: z.string().datetime().optional(),
    notes: z.string().max(COUPON_NOTES_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Per-kind amount bounds.
    if (data.kind === 'percent_off') {
      if (data.amount < COUPON_PERCENT_OFF_MIN || data.amount > COUPON_PERCENT_OFF_MAX) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: `percent_off amount must be between ${COUPON_PERCENT_OFF_MIN} and ${COUPON_PERCENT_OFF_MAX}`,
        });
      }
    } else if (data.kind === 'amount_off') {
      if (data.amount < COUPON_AMOUNT_OFF_MIN_MINOR || data.amount > COUPON_AMOUNT_OFF_MAX_MINOR) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: `amount_off amount must be between ${COUPON_AMOUNT_OFF_MIN_MINOR} and ${COUPON_AMOUNT_OFF_MAX_MINOR} minor units`,
        });
      }
    } else if (data.kind === 'extended_trial') {
      if (
        data.amount < COUPON_EXTENDED_TRIAL_MIN_DAYS ||
        data.amount > COUPON_EXTENDED_TRIAL_MAX_DAYS
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['amount'],
          message: `extended_trial amount must be between ${COUPON_EXTENDED_TRIAL_MIN_DAYS} and ${COUPON_EXTENDED_TRIAL_MAX_DAYS} days`,
        });
      }
      // Stripe coupons aren't created for extended_trial; durations are
      // meaningless. Reject anything but `once`.
      if (data.duration !== 'once') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duration'],
          message: 'extended_trial coupons must use duration=once',
        });
      }
    }

    // Repeating duration requires durationInMonths.
    if (data.duration === 'repeating' && data.durationInMonths === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationInMonths'],
        message: 'durationInMonths is required when duration=repeating',
      });
    }
    if (data.duration !== 'repeating' && data.durationInMonths !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['durationInMonths'],
        message: 'durationInMonths is only valid when duration=repeating',
      });
    }
  });
export type CreateCouponRequest = z.infer<typeof CreateCouponRequestSchema>;

/**
 * Validate-coupon request (POST /api/v1/coupons/validate).
 *
 * The client provides the code + the plan/customer context required
 * for the eligibility check; the response indicates whether the code
 * would apply at checkout and what the discount value is.
 *
 * **Rate-limited at the controller boundary** — repeated calls from
 * the same IP and/or account hit the Redis-backed sliding-window
 * guard (CLAUDE.md §12). Failed validations don't burn quota beyond
 * the request itself.
 */
export const ValidateCouponRequestSchema = z
  .object({
    code: CouponCodeSchema,
    planId: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64),
    customerGroup: PlanCustomerGroupSchema,
  })
  .strict();
export type ValidateCouponRequest = z.infer<typeof ValidateCouponRequestSchema>;

/**
 * Validate-coupon response. The DTO is intentionally narrower than
 * `CouponSchema` — the public validate surface doesn't echo back
 * admin-only fields (`notes`, `stripeCouponId`, etc.).
 *
 * `valueAppliedMinor` is the dollar value of the discount that WOULD
 * apply to the first invoice if the coupon is redeemed against the
 * given plan. For `extended_trial`, it's 0 (the value is in days, not
 * dollars); `extendedTrialDays` carries the trial extension.
 */
export const ValidateCouponResponseSchema = z
  .object({
    couponId: z.string().min(1).max(64),
    code: CouponCodeSchema,
    name: z.string().min(1).max(COUPON_NAME_MAX_LENGTH),
    kind: CouponKindSchema,
    duration: CouponDurationSchema,
    durationInMonths: z.number().int().min(1).max(COUPON_DURATION_IN_MONTHS_MAX).nullable(),
    valueAppliedMinor: z.number().int().min(0),
    extendedTrialDays: z.number().int().min(0).nullable(),
    currency: z.string().length(3),
  })
  .strict();
export type ValidateCouponResponse = z.infer<typeof ValidateCouponResponseSchema>;
