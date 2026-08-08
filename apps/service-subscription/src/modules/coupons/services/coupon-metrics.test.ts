import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CouponMetrics,
  couponValidationOutcome,
  type CouponValidationReason,
} from './coupon-metrics';

/**
 * `couponValidationOutcome` cardinality contract (TS-043-followup-8). Every
 * `CouponValidationFailure.reason` must round-trip to a bounded
 * `CouponValidateOutcome` literal — this pins the label space so a new
 * eligibility rule can't silently widen the metric cardinality (the call site
 * in CouponsController fails to type-check if a reason is not a
 * CouponValidationReason). Mirrors the `dunningFailureOutcome` test.
 */
describe('couponValidationOutcome', () => {
  it.each<CouponValidationReason>([
    'coupon_not_found',
    'coupon_inactive',
    'coupon_expired',
    'coupon_cap_reached',
    'coupon_plan_not_eligible',
    'coupon_min_spend_not_met',
    'coupon_per_customer_limit_reached',
    'coupon_first_time_only',
  ])('maps reason "%s" to the same outcome label', (reason) => {
    expect(couponValidationOutcome({ reason })).toBe(reason);
  });
});

/**
 * CouponMetrics instruments (TS-043-followup-8; CLAUDE.md §10). Mirrors the
 * DunningMetrics test shape: init a real MeterProvider, drive the recorder,
 * then assert the Prometheus text exposition. `CouponMetrics` must be
 * constructed AFTER `initMetrics` so its instruments bind to the live meter
 * rather than the no-op fallback.
 */
describe('CouponMetrics — Prometheus exposition', () => {
  let metrics: CouponMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-subscription-test',
      env: 'test',
      // Far-future sweep so the periodic reader never races the test;
      // serializeMetrics() forces a synchronous collect on each scrape.
      exportIntervalMillis: 3_600_000,
    });
    metrics = new CouponMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a validate pass with the outcome + rate_limit labels + a latency sample', async () => {
    metrics.recordValidate('ok', 'allowed', 0.004);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_validate_total\{[^}]*outcome="ok"[^}]*rate_limit="allowed"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /coupon_operation_duration_seconds_count\{[^}]*operation="validate"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a rate-limited validate with rate_limit="rate_limited"', async () => {
    metrics.recordValidate('rate_limited', 'rate_limited', 0.001);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_validate_total\{[^}]*outcome="rate_limited"[^}]*rate_limit="rate_limited"[^}]*\} 1/,
    );
  });

  it('counts a fail-open validate with rate_limit="unavailable"', async () => {
    metrics.recordValidate('coupon_expired', 'unavailable', 0.003);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_validate_total\{[^}]*outcome="coupon_expired"[^}]*rate_limit="unavailable"[^}]*\} 1/,
    );
  });

  it('counts a redemption with the outcome + kind labels', async () => {
    metrics.recordRedemption('ok', 'percent_off', 0.02);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_redemption_total\{[^}]*outcome="ok"[^}]*kind="percent_off"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /coupon_operation_duration_seconds_count\{[^}]*operation="record_redemption"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a redemption conflict with kind="amount_off"', async () => {
    metrics.recordRedemption('redemption_conflict', 'amount_off', 0.015);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /coupon_redemption_total\{[^}]*outcome="redemption_conflict"[^}]*kind="amount_off"[^}]*\} 1/,
    );
  });

  it('counts an ensure-stripe-coupon success', async () => {
    metrics.recordStripeEnsure('ok', 0.25);

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(
      /coupon_operation_duration_seconds_count\{[^}]*operation="ensure_stripe_coupon"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts cached / skipped_trial / stripe_unavailable ensure outcomes distinctly', async () => {
    metrics.recordStripeEnsure('cached', 0.002);
    metrics.recordStripeEnsure('skipped_trial', 0.002);
    metrics.recordStripeEnsure('stripe_unavailable', 0.4);

    const out = await serializeMetrics();
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="cached"[^}]*\} 1/);
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="skipped_trial"[^}]*\} 1/);
    expect(out).toMatch(/coupon_stripe_ensure_total\{[^}]*outcome="stripe_unavailable"[^}]*\} 1/);
  });

  it('never leaks a coupon code / customer / subscription / Stripe id onto the scrape surface', async () => {
    // The recorders only ever receive bounded label values — there is no API
    // surface to pass an id or a coupon code at all. This asserts the
    // negative: even after a full sweep of every instrument, no
    // identifier-shaped string appears.
    metrics.recordValidate('coupon_not_found', 'allowed', 0.001);
    metrics.recordRedemption('ok', 'extended_trial', 0.01);
    metrics.recordStripeEnsure('ok', 0.2);

    const out = await serializeMetrics();
    expect(out).not.toContain('cpn_');
    expect(out).not.toContain('cus_');
    expect(out).not.toContain('sub_');
    expect(out).not.toContain('coupon_stripe_xyz');
    // …but the instruments themselves are present.
    expect(out).toMatch(/coupon_validate_total/);
    expect(out).toMatch(/coupon_redemption_total/);
    expect(out).toMatch(/coupon_stripe_ensure_total/);
  });
});
