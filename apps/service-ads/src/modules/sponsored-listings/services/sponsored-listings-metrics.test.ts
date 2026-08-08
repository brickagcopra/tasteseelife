import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SponsoredListingsMetrics, sponsoredResolveOutcome } from './sponsored-listings-metrics';

/**
 * Full-surface tests for the sponsored-listings delivery instruments
 * (TS-218a-followup-3): boot a MeterProvider, record through the public method,
 * and assert the serialized Prometheus document carries the expected series +
 * labels. Plus pure-function coverage of the `outcome` bucketing. Mirrors the
 * SearchMetrics shape.
 *
 * A long export interval (1h) keeps the periodic reader's background sweep from
 * racing the inline `collect()` inside `serializeMetrics()`.
 */
describe('sponsoredResolveOutcome', () => {
  it('buckets by filled vs limit', () => {
    expect(sponsoredResolveOutcome(0, 3)).toBe('empty');
    expect(sponsoredResolveOutcome(2, 3)).toBe('partial');
    expect(sponsoredResolveOutcome(3, 3)).toBe('filled');
    expect(sponsoredResolveOutcome(4, 3)).toBe('filled');
  });
});

describe('SponsoredListingsMetrics', () => {
  let metrics: SponsoredListingsMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-ads-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    metrics = new SponsoredListingsMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records a resolve with the fill outcome plus the slot + candidate histograms', async () => {
    metrics.recordResolve({ candidateCount: 5, filledCount: 2, limit: 3 });

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE ads_sponsored_resolve_total counter/);
    expect(out).toMatch(/ads_sponsored_resolve_total\{[^}]*outcome="partial"[^}]*\} 1/);
    expect(out).toMatch(/ads_sponsored_slots_filled_count(\{[^}]*\})? 1/);
    expect(out).toMatch(/ads_sponsored_candidates_count(\{[^}]*\})? 1/);
  });

  it('partitions filled / partial / empty on distinct outcome series', async () => {
    metrics.recordResolve({ candidateCount: 3, filledCount: 3, limit: 3 });
    metrics.recordResolve({ candidateCount: 3, filledCount: 1, limit: 3 });
    metrics.recordResolve({ candidateCount: 0, filledCount: 0, limit: 3 });

    const out = await serializeMetrics();
    expect(out).toMatch(/ads_sponsored_resolve_total\{[^}]*outcome="filled"[^}]*\} 1/);
    expect(out).toMatch(/ads_sponsored_resolve_total\{[^}]*outcome="partial"[^}]*\} 1/);
    expect(out).toMatch(/ads_sponsored_resolve_total\{[^}]*outcome="empty"[^}]*\} 1/);
  });

  it('does not place the free-form slotCode on any metric label', async () => {
    metrics.recordResolve({ candidateCount: 4, filledCount: 1, limit: 2 });

    const out = await serializeMetrics();
    expect(out).not.toMatch(/slot_code/);
  });

  it('constructs without a booted SDK (no-op meter fallback)', async () => {
    await shutdownMetrics();
    const offline = new SponsoredListingsMetrics();
    expect(() =>
      offline.recordResolve({ candidateCount: 1, filledCount: 0, limit: 1 }),
    ).not.toThrow();
  });
});
