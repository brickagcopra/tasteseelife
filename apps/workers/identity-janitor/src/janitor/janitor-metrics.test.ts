import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JanitorMetrics } from './janitor-metrics';

/**
 * Exercises the FULL surface — init → record via {@link JanitorMetrics} →
 * serialize — so the test proves the three janitor instruments actually
 * render in Prometheus text format with the expected names + `table`
 * labels, not merely that a method was called.
 *
 * Long export interval (1h) so the periodic reader's background sweep
 * doesn't race the inline `collect()` inside `serializeMetrics()`.
 */
describe('JanitorMetrics', () => {
  beforeEach(() => {
    initMetrics({
      service: 'worker-identity-janitor-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('renders rows-deleted as a per-table counter', async () => {
    const metrics = new JanitorMetrics();
    metrics.recordRowsDeleted('refresh_tokens', 12);
    metrics.recordRowsDeleted('mfa_challenges', 3);

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE identity_janitor_rows_deleted_total counter/);
    expect(out).toMatch(
      /identity_janitor_rows_deleted_total\{[^}]*table="refresh_tokens"[^}]*\} 12/,
    );
    expect(out).toMatch(
      /identity_janitor_rows_deleted_total\{[^}]*table="mfa_challenges"[^}]*\} 3/,
    );
  });

  it('records a zero-valued rows-deleted series so an idle sweep is still visible', async () => {
    const metrics = new JanitorMetrics();
    metrics.recordRowsDeleted('refresh_tokens', 0);

    const out = await serializeMetrics();

    expect(out).toMatch(
      /identity_janitor_rows_deleted_total\{[^}]*table="refresh_tokens"[^}]*\} 0/,
    );
  });

  it('renders sweep errors as a per-table counter', async () => {
    const metrics = new JanitorMetrics();
    metrics.recordSweepError('refresh_tokens');
    metrics.recordSweepError('refresh_tokens');

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE identity_janitor_sweep_errors_total counter/);
    expect(out).toMatch(
      /identity_janitor_sweep_errors_total\{[^}]*table="refresh_tokens"[^}]*\} 2/,
    );
  });

  it('renders sweep duration as a histogram (count / sum / bucket)', async () => {
    const metrics = new JanitorMetrics();
    metrics.recordSweepDuration(0.004);
    metrics.recordSweepDuration(0.041);

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE identity_janitor_sweep_duration_seconds histogram/);
    expect(out).toMatch(/identity_janitor_sweep_duration_seconds_count(\{[^}]*\})? 2/);
    expect(out).toMatch(/identity_janitor_sweep_duration_seconds_sum/);
    expect(out).toMatch(/identity_janitor_sweep_duration_seconds_bucket/);
  });

  it('is safe to construct + record when metrics are not initialized', async () => {
    // No initMetrics in this case — getMeter returns the OTel no-op meter,
    // so recording must not throw (unit tests + CLI contexts rely on this).
    await shutdownMetrics();
    const metrics = new JanitorMetrics();
    expect(() => {
      metrics.recordRowsDeleted('refresh_tokens', 5);
      metrics.recordSweepError('mfa_challenges');
      metrics.recordSweepDuration(0.01);
    }).not.toThrow();
  });
});
