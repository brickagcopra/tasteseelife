import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecognitionMetrics } from './recognition-metrics';

/**
 * Full-surface tests for the pause / resume instrument
 * (TS-042-followup-3b2-followup-2): boot a MeterProvider, record through the
 * public method, assert the serialized Prometheus document carries the series
 * and the exact labels a dashboard would query.
 *
 * A long export interval keeps the periodic reader's background sweep from
 * racing the inline `collect()` inside `serializeMetrics()`.
 */
describe('RecognitionMetrics', () => {
  let metrics: RecognitionMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-accounting-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    metrics = new RecognitionMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('exposes the counter and records an applied pause', async () => {
    metrics.record('pause', 'applied');

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE accounting_recognition_pause_total counter/);
    expect(out).toMatch(
      /accounting_recognition_pause_total\{[^}]*operation="pause"[^}]*result="applied"[^}]*\} 1/,
    );
  });

  it('partitions pause and resume onto distinct series', async () => {
    // The gap between these two series over time IS the
    // TS-042-followup-3b2-followup-1 failure mode — balances suspended and
    // never restarted. That is why `operation` is a label rather than two
    // separate instruments.
    metrics.record('pause', 'applied');
    metrics.record('resume', 'applied');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /accounting_recognition_pause_total\{[^}]*operation="pause"[^}]*result="applied"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /accounting_recognition_pause_total\{[^}]*operation="resume"[^}]*result="applied"[^}]*\} 1/,
    );
  });

  it('records the silent arm — no_balance gets its own series', async () => {
    // The label that justifies the instrument: nothing broke, nothing was
    // suspended, and only a number reveals it.
    metrics.record('pause', 'no_balance');
    metrics.record('pause', 'no_balance');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /accounting_recognition_pause_total\{[^}]*operation="pause"[^}]*result="no_balance"[^}]*\} 2/,
    );
  });

  it('records idempotent replays separately from applied', async () => {
    metrics.record('resume', 'idempotent_replay');
    metrics.record('resume', 'applied');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /accounting_recognition_pause_total\{[^}]*result="idempotent_replay"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /accounting_recognition_pause_total\{[^}]*operation="resume"[^}]*result="applied"[^}]*\} 1/,
    );
  });

  it('carries no identifiers — a subscription id is not a label', async () => {
    metrics.record('pause', 'applied');
    metrics.record('resume', 'no_balance');

    const out = await serializeMetrics();
    const series = out
      .split('\n')
      .filter((line) => line.startsWith('accounting_recognition_pause_total{'));
    expect(series.length).toBeGreaterThan(0);
    for (const line of series) {
      const labels = line.slice(line.indexOf('{') + 1, line.indexOf('}'));
      // Which family paused their mother's care is not telemetry
      // (CLAUDE.md §3.9, §10, §12). Matches on the platform's id prefixes
      // and on the label NAMES an identifier would arrive under — not on
      // bare words, since `no_balance` is a legitimate result value.
      expect(labels).not.toMatch(/"(sub|cus|hh|drb)_/);
      expect(labels).not.toMatch(/\b(subscription_id|customer_id|balance_id)=/);
      // Deliberately closed-world: an allow-list, so a label nobody intended
      // fails here rather than shipping. `otel_scope_*` joined the set in
      // TS-151-followup-20c — OTel SDK v2's Prometheus serializer stamps the
      // emitting meter's name/version on every series per the OTel→Prometheus
      // compatibility spec. They are bounded-cardinality provenance (one pair
      // per meter, e.g. `service-accounting:revenue-recognition`), carry no
      // subject identifier, and so do not weaken the guard above.
      expect(labels.match(/(\w+)=/g)?.sort()).toEqual([
        'operation=',
        'otel_scope_name=',
        'otel_scope_version=',
        'result=',
      ]);
    }
  });
});
