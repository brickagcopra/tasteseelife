import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TargetingMetrics } from './targeting-metrics';

/**
 * Full-surface tests for the targeting-engine instruments (TS-273-followup-1):
 * boot a MeterProvider, record through the public method, and assert the
 * serialized Prometheus document carries the expected series + labels. Proves
 * the instruments are wired to the global meter and the label sets are exactly
 * what dashboards/alerts query. Mirrors the SearchMetrics shape.
 *
 * A long export interval (1h) keeps the periodic reader's background sweep from
 * racing the inline `collect()` inside `serializeMetrics()`.
 */
describe('TargetingMetrics', () => {
  let metrics: TargetingMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-ads-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    metrics = new TargetingMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records an evaluation with the match label', async () => {
    metrics.recordEvaluation({ match: true, malformedRuleCount: 0 });
    metrics.recordEvaluation({ match: true, malformedRuleCount: 0 });

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE ads_targeting_evaluations_total counter/);
    expect(out).toMatch(/ads_targeting_evaluations_total\{[^}]*match="true"[^}]*\} 2/);
  });

  it('partitions match vs no-match on distinct series', async () => {
    metrics.recordEvaluation({ match: true, malformedRuleCount: 0 });
    metrics.recordEvaluation({ match: false, malformedRuleCount: 0 });

    const out = await serializeMetrics();
    expect(out).toMatch(/ads_targeting_evaluations_total\{[^}]*match="true"[^}]*\} 1/);
    expect(out).toMatch(/ads_targeting_evaluations_total\{[^}]*match="false"[^}]*\} 1/);
  });

  it('counts malformed rule rows by the malformed count, not per evaluation', async () => {
    metrics.recordEvaluation({ match: false, malformedRuleCount: 2 });
    metrics.recordEvaluation({ match: false, malformedRuleCount: 3 });

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE ads_targeting_rules_malformed_total counter/);
    expect(out).toMatch(/ads_targeting_rules_malformed_total(\{[^}]*\})? 5/);
  });

  it('leaves the malformed series untouched for a clean evaluation', async () => {
    metrics.recordEvaluation({ match: true, malformedRuleCount: 0 });

    const out = await serializeMetrics();
    expect(out).not.toMatch(/ads_targeting_rules_malformed_total/);
  });

  it('constructs without a booted SDK (no-op meter fallback)', async () => {
    await shutdownMetrics();
    const offline = new TargetingMetrics();
    expect(() => offline.recordEvaluation({ match: true, malformedRuleCount: 1 })).not.toThrow();
  });
});
