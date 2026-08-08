import { Injectable } from '@nestjs/common';
import type { CouponKind } from '@taste-and-see/contracts';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'service-subscription:coupons';

/**
 * The eight coupon-eligibility rejection reasons (PRD §10.4), mirroring
 * `CouponValidationFailure['reason']` in `coupons.service.ts` 1:1. Hoisted to
 * its own union so {@link CouponValidateOutcome} can compose it AND
 * {@link couponValidationOutcome} can pin the cardinality contract: if a new
 * eligibility rule is added to `CouponValidationFailure` that is not also a
 * member here, the call site fails to type-check. The label space therefore
 * cannot silently widen (CLAUDE.md §10, §17.2).
 */
export type CouponValidationReason =
  | 'coupon_not_found'
  | 'coupon_inactive'
  | 'coupon_expired'
  | 'coupon_cap_reached'
  | 'coupon_plan_not_eligible'
  | 'coupon_min_spend_not_met'
  | 'coupon_per_customer_limit_reached'
  | 'coupon_first_time_only';

/**
 * Bounded `outcome` label for `coupon_validate_total`. `ok` is a successful
 * eligibility pass; `rate_limited` is the abuse-guard short-circuit (also
 * captured in the orthogonal `rate_limit` dimension); `plan_not_found` is the
 * controller-side plan lookup miss; the eight {@link CouponValidationReason}
 * members are the per-rule rejections; `error` is the unexpected-throw
 * catch-all so a 500 stays visible on the scrape surface.
 */
export type CouponValidateOutcome =
  | 'ok'
  | 'rate_limited'
  | 'plan_not_found'
  | CouponValidationReason
  | 'error';

/**
 * Orthogonal `rate_limit` dimension on `coupon_validate_total`: `allowed`
 * (under the cap), `rate_limited` (a bucket crossed its cap), or `unavailable`
 * (Redis down → the controller failed open per CLAUDE.md §4.3).
 */
export type CouponRateLimitLabel = 'allowed' | 'rate_limited' | 'unavailable';

/**
 * Bounded `outcome` label for `coupon_redemption_total`. `recordRedemption`
 * only ever returns `ok` or `redemption_conflict` (the unique
 * `(coupon_id, subscription_id)` race loser); any other Prisma error rethrows
 * and lands as `error`.
 */
export type CouponRedemptionOutcome = 'ok' | 'redemption_conflict' | 'error';

/**
 * Bounded `outcome` label for `coupon_stripe_ensure_total`. `ok` is a freshly
 * created Stripe Coupon; `cached` is the idempotent hit on an already-cached
 * `stripe_coupon_id`; `skipped_trial` is the `extended_trial` short-circuit
 * (no Stripe Coupon is needed — the extension rides `trial_period_days`);
 * `coupon_not_found` is the deactivated-between-validate-and-ensure race;
 * `stripe_unavailable` is a Stripe API failure; `error` is the
 * unexpected-throw catch-all.
 */
export type CouponStripeEnsureOutcome =
  | 'ok'
  | 'cached'
  | 'skipped_trial'
  | 'coupon_not_found'
  | 'stripe_unavailable'
  | 'error';

/** The three logical coupon operations — the bounded `operation` label on the shared latency histogram. */
export type CouponOperation = 'validate' | 'record_redemption' | 'ensure_stripe_coupon';

type CouponAnyOutcome = CouponValidateOutcome | CouponRedemptionOutcome | CouponStripeEnsureOutcome;

/**
 * Map a `CouponValidationFailure` to its bounded `outcome` metric label.
 *
 * The parameter type is `{ reason: CouponValidationReason }` rather than an
 * import of `CouponValidationFailure` — keeping `coupon-metrics.ts` free of a
 * runtime dependency on `coupons.service.ts` (no import cycle) while still
 * pinning the cardinality contract: the call site in `CouponsController`
 * passes the real `CouponValidationFailure`, so if a new eligibility reason is
 * added that is NOT a {@link CouponValidationReason}, the call fails to
 * type-check. Mirrors `dunningFailureOutcome` (TS-042-followup-8).
 */
export function couponValidationOutcome(failure: {
  readonly reason: CouponValidationReason;
}): CouponValidateOutcome {
  return failure.reason;
}

/**
 * service-subscription's coupon-domain Prometheus instruments
 * (TS-043-followup-8).
 *
 * Three counters — one per coupon surface — plus one shared latency
 * histogram:
 *
 *   - `coupon_validate_total{outcome,rate_limit}` — every
 *     `POST /api/v1/coupons/validate` request. The `outcome` dimension names
 *     the eligibility result (or `plan_not_found` / `rate_limited`); the
 *     orthogonal `rate_limit` dimension names the abuse-guard decision. A
 *     rising `rate_limited` rate is the leading indicator of coupon-code
 *     brute-forcing (CLAUDE.md §12); a rising `unavailable` rate means Redis
 *     is down and the gate is failing open.
 *   - `coupon_redemption_total{outcome,kind}` — every `recordRedemption`
 *     call (one per coupon actually applied to a subscription). The `kind`
 *     dimension (`percent_off`/`amount_off`/`extended_trial`) lets a dashboard
 *     track which promo shapes convert; a rising `redemption_conflict` rate
 *     means concurrent checkout retries are racing the per-subscription unique
 *     index.
 *   - `coupon_stripe_ensure_total{outcome}` — every `ensureStripeCoupon`
 *     call. A rising `stripe_unavailable` rate is the leading indicator of a
 *     Stripe outage or a rotated `STRIPE_SECRET_KEY`; `cached` vs `ok`
 *     partitions repeat redemptions from first-use lazy creation.
 *   - `coupon_operation_duration_seconds{operation,outcome}` — latency of
 *     each operation, bucketed by operation + outcome so the cheap DB-only
 *     `validate` short-circuits don't skew the Stripe-round-trip histogram for
 *     `ensure_stripe_coupon`.
 *
 * **PII / cardinality discipline (CLAUDE.md §3.9, §10, §17.2).** Every label
 * is a fixed string-literal union — `outcome`, `rate_limit`, `kind`, and
 * `operation` are all bounded by construction. No label is ever derived from a
 * coupon code, customer id, subscription id, or Stripe id: a coupon code is
 * not PII but IS unbounded (one series per promo would blow cardinality), and
 * a customer id is both PII and unbounded. The coupon code rides only on the
 * structured logs (where it is acceptable per the acceptance note) and never
 * on a metric label or span attribute here.
 *
 * Instruments are created via `getMeter`, which returns a usable no-op meter
 * when `initMetrics` was never called — so this class is safe to construct in
 * unit tests without booting the SDK. Mirrors the `DunningMetrics`
 * (TS-042-followup-8) / `KycMetrics` (TS-026-followup-7) domain-instrument
 * shape.
 */
@Injectable()
export class CouponMetrics {
  private readonly validateCounter: Counter;
  private readonly redemptionCounter: Counter;
  private readonly stripeEnsureCounter: Counter;
  private readonly duration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.validateCounter = meter.createCounter('coupon_validate_total', {
      description:
        'Total coupon-validate requests, by eligibility outcome and rate-limit decision.',
    });
    this.redemptionCounter = meter.createCounter('coupon_redemption_total', {
      description: 'Total coupon redemptions persisted, by outcome and coupon kind.',
    });
    this.stripeEnsureCounter = meter.createCounter('coupon_stripe_ensure_total', {
      description: 'Total ensureStripeCoupon calls, by outcome.',
    });
    this.duration = meter.createHistogram('coupon_operation_duration_seconds', {
      description: 'Latency of coupon operations in seconds, by operation and outcome.',
      unit: 's',
    });
  }

  /** Record one coupon-validate outcome (counter + latency). */
  recordValidate(
    outcome: CouponValidateOutcome,
    rateLimit: CouponRateLimitLabel,
    seconds: number,
  ): void {
    this.validateCounter.add(1, { outcome, rate_limit: rateLimit });
    this.recordDuration('validate', outcome, seconds);
  }

  /** Record one `recordRedemption` outcome (counter + latency). */
  recordRedemption(outcome: CouponRedemptionOutcome, kind: CouponKind, seconds: number): void {
    this.redemptionCounter.add(1, { outcome, kind });
    this.recordDuration('record_redemption', outcome, seconds);
  }

  /** Record one `ensureStripeCoupon` outcome (counter + latency). */
  recordStripeEnsure(outcome: CouponStripeEnsureOutcome, seconds: number): void {
    this.stripeEnsureCounter.add(1, { outcome });
    this.recordDuration('ensure_stripe_coupon', outcome, seconds);
  }

  private recordDuration(
    operation: CouponOperation,
    outcome: CouponAnyOutcome,
    seconds: number,
  ): void {
    this.duration.record(seconds, { operation, outcome });
  }
}

/** Elapsed wall-clock seconds since `startNs` (a `process.hrtime.bigint()` mark). */
export function elapsedSeconds(startNs: bigint): number {
  return Number(process.hrtime.bigint() - startNs) / 1e9;
}
