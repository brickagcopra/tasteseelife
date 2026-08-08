import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderPricingMetrics,
  pricingFailureOutcome,
  type ProviderPricingFailureOutcome,
} from './provider-pricing-metrics';

/**
 * Cardinality-contract mapper (TS-204-followup-4). `pricingFailureOutcome`
 * is the identity on the failure `reason` — each reason IS a bounded
 * outcome member — so a new failure reason can't silently widen the metric
 * label space: the call site fails to type-check if a reason escapes the
 * bounded union. Mirrors `certificationFailureOutcome` (TS-052-followup-9).
 */
describe('pricingFailureOutcome', () => {
  it.each<ProviderPricingFailureOutcome>([
    'invalid_request',
    'not_found',
    'forbidden',
    'precondition_failed',
    'unsupported_currency',
    'out_of_band',
    'outbox_validation_failed',
  ])('maps reason "%s" to the same outcome label', (reason) => {
    // The non-reason fields differ per variant; the mapper ignores them.
    expect(pricingFailureOutcome({ reason } as never)).toBe(reason);
  });
});

/**
 * ProviderPricingMetrics instruments (TS-204-followup-4; CLAUDE.md §10).
 * Init a real MeterProvider, drive the recorder, assert the Prometheus
 * exposition. Mirrors the CertificationsMetrics test shape.
 */
describe('ProviderPricingMetrics — Prometheus exposition', () => {
  let metrics: ProviderPricingMetrics;

  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
    metrics = new ProviderPricingMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a set outcome + latency', async () => {
    metrics.recordUpdate('set', 0.012);
    const out = await serializeMetrics();
    expect(out).toMatch(/provider_pricing_updates_total\{[^}]*outcome="set"[^}]*\} 1/);
    expect(out).toMatch(
      /provider_pricing_update_duration_seconds_count\{[^}]*outcome="set"[^}]*\} 1/,
    );
  });

  it('counts a no-op short-circuit separately from a set', async () => {
    metrics.recordUpdate('set', 0.01);
    metrics.recordUpdate('noop', 0.001);
    const out = await serializeMetrics();
    expect(out).toMatch(/provider_pricing_updates_total\{[^}]*outcome="set"[^}]*\} 1/);
    expect(out).toMatch(/provider_pricing_updates_total\{[^}]*outcome="noop"[^}]*\} 1/);
  });

  it('counts distinct failure outcomes separately', async () => {
    metrics.recordUpdate('out_of_band', 0.001);
    metrics.recordUpdate('forbidden', 0.001);
    const out = await serializeMetrics();
    expect(out).toMatch(/provider_pricing_updates_total\{[^}]*outcome="out_of_band"[^}]*\} 1/);
    expect(out).toMatch(/provider_pricing_updates_total\{[^}]*outcome="forbidden"[^}]*\} 1/);
  });

  it('records the error catch-all outcome', async () => {
    metrics.recordUpdate('error', 0.005);
    const out = await serializeMetrics();
    expect(out).toMatch(/provider_pricing_updates_total\{[^}]*outcome="error"[^}]*\} 1/);
    expect(out).toMatch(
      /provider_pricing_update_duration_seconds_count\{[^}]*outcome="error"[^}]*\} 1/,
    );
  });

  it('never leaks a providerId / actor id / rate / currency onto the scrape surface', async () => {
    metrics.recordUpdate('set', 0.01);
    const out = await serializeMetrics();
    expect(out).not.toContain('prov_');
    expect(out).not.toContain('user_');
    // `outcome` is the only label key — no rate / currency / id label ever
    // appears (a numeric like 7500 shows only as a histogram `le=` bucket
    // boundary, never as a value label).
    expect(out).not.toMatch(/\bcurrency="/);
    expect(out).not.toMatch(/\brate="/);
    expect(out).not.toMatch(/\bprovider_id="/);
    expect(out).toMatch(/provider_pricing_updates_total/);
  });
});
