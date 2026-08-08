import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DunningMetrics, dunningFailureOutcome, type DunningOutcome } from './dunning-metrics';

/**
 * `dunningFailureOutcome` cardinality contract (TS-042-followup-8). Every
 * `DunningFailure.reason` must round-trip to a bounded `DunningOutcome`
 * literal — this pins the label space so a new failure reason can't silently
 * widen the metric cardinality (the call site in DunningService fails to
 * type-check if a reason is not a DunningOutcome).
 */
describe('dunningFailureOutcome', () => {
  it.each<Exclude<DunningOutcome, 'ok'>>([
    'subscription_not_found',
    'invalid_state',
    'grace_not_expired',
    'invalid_request',
    'stripe_unavailable',
  ])('maps reason "%s" to the same outcome label', (reason) => {
    expect(dunningFailureOutcome({ reason })).toBe(reason);
  });
});

/**
 * DunningMetrics instruments (TS-042-followup-8; CLAUDE.md §10). Mirrors the
 * KycMetrics test shape: init a real MeterProvider, drive the recorder, then
 * assert the Prometheus text exposition. `DunningMetrics` must be constructed
 * AFTER `initMetrics` so its instruments bind to the live meter rather than
 * the no-op fallback.
 */
describe('DunningMetrics — Prometheus exposition', () => {
  let metrics: DunningMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-subscription-test',
      env: 'test',
      // Far-future sweep so the periodic reader never races the test;
      // serializeMetrics() forces a synchronous collect on each scrape.
      exportIntervalMillis: 3_600_000,
    });
    metrics = new DunningMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a payment failure with the outcome label + a latency sample', async () => {
    metrics.recordPaymentFailure('ok', 0.012);

    const out = await serializeMetrics();
    expect(out).toMatch(/dunning_payment_failure_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(
      /dunning_operation_duration_seconds_count\{[^}]*operation="record_payment_failure"[^}]*outcome="ok"[^}]*\} 1/,
    );
  });

  it('counts a payment success with the outcome + recovered labels', async () => {
    metrics.recordPaymentSuccess('ok', true, 0.02);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /dunning_payment_success_total\{[^}]*outcome="ok"[^}]*recovered="true"[^}]*\} 1/,
    );
  });

  it('records recovered="false" for a routine (non-recovery) success', async () => {
    metrics.recordPaymentSuccess('ok', false, 0.02);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /dunning_payment_success_total\{[^}]*outcome="ok"[^}]*recovered="false"[^}]*\} 1/,
    );
  });

  it('counts an exhaustion outcome', async () => {
    metrics.recordExhaustion('grace_not_expired', 0.001);

    const out = await serializeMetrics();
    expect(out).toMatch(/dunning_exhaustion_total\{[^}]*outcome="grace_not_expired"[^}]*\} 1/);
  });

  it('counts a pause failure with outcome="stripe_unavailable"', async () => {
    metrics.recordPause('stripe_unavailable', 0.3);

    const out = await serializeMetrics();
    expect(out).toMatch(/dunning_pause_total\{[^}]*outcome="stripe_unavailable"[^}]*\} 1/);
    expect(out).toMatch(
      /dunning_operation_duration_seconds_count\{[^}]*operation="pause"[^}]*outcome="stripe_unavailable"[^}]*\} 1/,
    );
  });

  it('counts a resume outcome', async () => {
    metrics.recordResume('ok', 0.25);

    const out = await serializeMetrics();
    expect(out).toMatch(/dunning_resume_total\{[^}]*outcome="ok"[^}]*\} 1/);
  });

  it('never leaks a subscription / customer / Stripe id onto the scrape surface', async () => {
    // The recorder only ever receives bounded label values — there is no API
    // surface to pass an id at all. This asserts the negative: even after a
    // full sweep of every instrument, no identifier-shaped string appears.
    metrics.recordPaymentFailure('subscription_not_found', 0.001);
    metrics.recordPaymentSuccess('ok', true, 0.01);
    metrics.recordExhaustion('ok', 0.01);
    metrics.recordPause('ok', 0.2);
    metrics.recordResume('ok', 0.2);

    const out = await serializeMetrics();
    expect(out).not.toContain('sub_');
    expect(out).not.toContain('cus_');
    expect(out).not.toContain('hh_');
    // …but the instruments themselves are present.
    expect(out).toMatch(/dunning_payment_failure_total/);
    expect(out).toMatch(/dunning_resume_total/);
  });
});
