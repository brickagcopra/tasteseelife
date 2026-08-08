import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebhookMetrics } from './webhook-metrics';

/**
 * Full-surface tests for the domain counters (TS-041a-followup-4): boot a
 * MeterProvider, record through the public methods, and assert the
 * serialized Prometheus document carries the expected series + labels.
 * This proves the counters are wired to the global meter and that the
 * label sets are exactly what the dashboards/alerts query — not just that
 * a method was called. Mirrors the janitor-metrics.test.ts shape
 * (TS-022-followup-3a).
 *
 * A long export interval (1h) keeps the periodic reader's background
 * sweep from racing the inline `collect()` inside `serializeMetrics()`.
 */
describe('WebhookMetrics', () => {
  let metrics: WebhookMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-webhook-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    metrics = new WebhookMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records a verified Stripe request with result + reason labels', async () => {
    metrics.recordStripeVerification('ok', 'none');

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE stripe_webhook_verified_total counter/);
    expect(out).toMatch(
      /stripe_webhook_verified_total\{[^}]*result="ok"[^}]*reason="none"[^}]*\} 1/,
    );
  });

  it('records a rejected Stripe request carrying the precise verifier reason', async () => {
    metrics.recordStripeVerification('reject', 'invalid_signature');
    metrics.recordStripeVerification('reject', 'missing_raw_body');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /stripe_webhook_verified_total\{[^}]*result="reject"[^}]*reason="invalid_signature"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /stripe_webhook_verified_total\{[^}]*result="reject"[^}]*reason="missing_raw_body"[^}]*\} 1/,
    );
  });

  it('records Stripe persistence outcomes (persisted / duplicate) under distinct label sets', async () => {
    metrics.recordStripePersisted('persisted');
    metrics.recordStripePersisted('persisted');
    metrics.recordStripePersisted('duplicate');

    const out = await serializeMetrics();
    expect(out).toMatch(/stripe_webhook_persisted_total\{[^}]*outcome="persisted"[^}]*\} 2/);
    expect(out).toMatch(/stripe_webhook_persisted_total\{[^}]*outcome="duplicate"[^}]*\} 1/);
  });

  it('records Checkr verification + persistence on independent series from Stripe', async () => {
    metrics.recordCheckrVerification('reject', 'replay_outside_tolerance');
    metrics.recordCheckrPersisted('persisted');

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE checkr_webhook_verified_total counter/);
    expect(out).toMatch(
      /checkr_webhook_verified_total\{[^}]*result="reject"[^}]*reason="replay_outside_tolerance"[^}]*\} 1/,
    );
    expect(out).toMatch(/checkr_webhook_persisted_total\{[^}]*outcome="persisted"[^}]*\} 1/);
  });

  it('records a Checkr dispatch outcome with latency for the request branches', async () => {
    metrics.recordCheckrDispatch('applied', 0.031);

    const out = await serializeMetrics();
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="applied"[^}]*\} 1/);
    expect(out).toMatch(/checkr_dispatch_duration_seconds_count\{[^}]*outcome="applied"[^}]*\} 1/);
  });

  it('records a skipped Checkr dispatch as a counter increment with no latency sample', async () => {
    metrics.recordCheckrDispatch('skipped');

    const out = await serializeMetrics();
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="skipped"[^}]*\} 1/);
    // No latency series for the skipped no-op (it never made a request).
    expect(out).not.toMatch(
      /checkr_dispatch_duration_seconds_count\{[^}]*outcome="skipped"[^}]*\}/,
    );
  });

  it('partitions Checkr dispatch failure outcomes on distinct series', async () => {
    metrics.recordCheckrDispatch('network_error', 0.5);
    metrics.recordCheckrDispatch('http_error', 0.2);
    metrics.recordCheckrDispatch('bad_response', 0.1);

    const out = await serializeMetrics();
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="network_error"[^}]*\} 1/);
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="http_error"[^}]*\} 1/);
    expect(out).toMatch(/checkr_dispatch_total\{[^}]*outcome="bad_response"[^}]*\} 1/);
  });

  it('constructs without a booted SDK (no-op meter fallback)', async () => {
    // Tear the harness provider down to simulate the OTEL_METRICS_ENABLED=false
    // path: getMeter returns a usable no-op meter, so construction + recording
    // must not throw.
    await shutdownMetrics();
    const offline = new WebhookMetrics();
    expect(() => offline.recordStripeVerification('ok', 'none')).not.toThrow();
    expect(() => offline.recordCheckrPersisted('duplicate')).not.toThrow();
    expect(() => offline.recordCheckrDispatch('skipped')).not.toThrow();
  });
});
