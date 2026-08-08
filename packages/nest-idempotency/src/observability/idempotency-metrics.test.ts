import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  elapsedSeconds,
  IdempotencyMetrics,
  type IdempotencyDecision,
} from './idempotency-metrics';

/**
 * IdempotencyMetrics instruments (TS-044-followup-4; CLAUDE.md §10). Mirrors
 * the CouponMetrics test shape: init a real MeterProvider, drive the recorder,
 * then assert the Prometheus text exposition. `IdempotencyMetrics` must be
 * constructed AFTER `initMetrics` so its instruments bind to the live meter
 * rather than the no-op fallback.
 */
describe('IdempotencyMetrics — Prometheus exposition', () => {
  let metrics: IdempotencyMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'nest-idempotency-test',
      env: 'test',
      // Far-future sweep so the periodic reader never races the test;
      // serializeMetrics() forces a synchronous collect on each scrape.
      exportIntervalMillis: 3_600_000,
    });
    metrics = new IdempotencyMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it.each<IdempotencyDecision>([
    'claimed',
    'cached_hit',
    'cached_mismatch',
    'in_flight',
    'unavailable',
  ])('counts a "%s" decision with the decision label', async (decision) => {
    metrics.recordDecision(decision);

    const out = await serializeMetrics();
    expect(out).toMatch(
      new RegExp(`idempotency_decisions_total\\{[^}]*decision="${decision}"[^}]*\\} 1`),
    );
  });

  it('records claim-to-complete latency keyed by decision', async () => {
    metrics.recordDuration('claimed', 0.042);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /idempotency_operation_duration_seconds_count\{[^}]*decision="claimed"[^}]*\} 1/,
    );
  });

  it('keeps the short-circuit and claimed latency series distinct', async () => {
    metrics.recordDuration('cached_hit', 0.001);
    metrics.recordDuration('claimed', 0.5);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /idempotency_operation_duration_seconds_count\{[^}]*decision="cached_hit"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /idempotency_operation_duration_seconds_count\{[^}]*decision="claimed"[^}]*\} 1/,
    );
  });

  it('never leaks an idempotency key / actor / Redis key onto the scrape surface', async () => {
    // The recorders only ever receive bounded `decision` label values — there
    // is no API surface to pass a key, actor, or request body at all. This
    // asserts the negative: even after sweeping every instrument, no
    // key-shaped string appears.
    metrics.recordDecision('claimed');
    metrics.recordDuration('claimed', 0.01);

    const out = await serializeMetrics();
    expect(out).not.toContain('idempotency-key');
    expect(out).not.toContain('Idempotency-Key');
    // The label is `decision`, never `key` / `actor` / `user`.
    expect(out).not.toMatch(/idempotency_decisions_total\{[^}]*\bkey=/);
    expect(out).not.toMatch(/idempotency_decisions_total\{[^}]*\bactor=/);
    // …but the instruments themselves are present.
    expect(out).toMatch(/idempotency_decisions_total/);
    expect(out).toMatch(/idempotency_operation_duration_seconds/);
  });
});

/**
 * `elapsedSeconds` converts an `hrtime.bigint()` start mark into fractional
 * seconds. The exact value is non-deterministic, but it must be a finite,
 * non-negative number — the histogram contract.
 */
describe('elapsedSeconds', () => {
  it('returns a finite, non-negative second count', () => {
    const start = process.hrtime.bigint();
    const elapsed = elapsedSeconds(start);
    expect(Number.isFinite(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});
