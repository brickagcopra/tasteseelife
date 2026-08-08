import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyFailureReason, RelayMetrics } from './relay-metrics';

/**
 * Exercises the FULL surface — init → record via {@link RelayMetrics} →
 * serialize — so the test proves the seven relay instruments actually
 * render in Prometheus text format with the expected names + labels,
 * not merely that a method was called.
 *
 * Long export interval (1h) so the periodic reader's background sweep
 * doesn't race the inline `collect()` inside `serializeMetrics()`.
 */
describe('RelayMetrics', () => {
  beforeEach(() => {
    initMetrics({
      service: 'worker-outbox-relay-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('renders polls as a counter labelled by source + outcome', async () => {
    const metrics = new RelayMetrics();
    metrics.recordPoll('subscription.outbox_events', 'ok');
    metrics.recordPoll('subscription.outbox_events', 'ok');
    metrics.recordPoll('booking.outbox_events', 'claim_failed');

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE outbox_relay_polls_total counter/);
    expect(out).toMatch(
      /outbox_relay_polls_total\{[^}]*source="subscription\.outbox_events"[^}]*outcome="ok"[^}]*\} 2/,
    );
    expect(out).toMatch(
      /outbox_relay_polls_total\{[^}]*source="booking\.outbox_events"[^}]*outcome="claim_failed"[^}]*\} 1/,
    );
  });

  it('renders dispatched rows as a counter labelled by source + event_name', async () => {
    const metrics = new RelayMetrics();
    metrics.recordDispatched('subscription.outbox_events', 'subscription.activated');
    metrics.recordDispatched('subscription.outbox_events', 'subscription.activated');

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE outbox_relay_rows_dispatched_total counter/);
    expect(out).toMatch(
      /outbox_relay_rows_dispatched_total\{[^}]*source="subscription\.outbox_events"[^}]*event_name="subscription\.activated"[^}]*\} 2/,
    );
  });

  it('renders failures as a counter labelled by source + event_name + bounded reason', async () => {
    const metrics = new RelayMetrics();
    metrics.recordFailed('booking.outbox_events', 'booking.completed', 'bus_unavailable');

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE outbox_relay_rows_failed_total counter/);
    expect(out).toMatch(
      /outbox_relay_rows_failed_total\{[^}]*source="booking\.outbox_events"[^}]*event_name="booking\.completed"[^}]*reason="bus_unavailable"[^}]*\} 1/,
    );
  });

  it('renders dead-lettered rows as a counter labelled by source + event_name', async () => {
    const metrics = new RelayMetrics();
    metrics.recordDeadLettered('booking.outbox_events', 'booking.completed');

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE outbox_relay_rows_dead_lettered_total counter/);
    expect(out).toMatch(
      /outbox_relay_rows_dead_lettered_total\{[^}]*source="booking\.outbox_events"[^}]*event_name="booking\.completed"[^}]*\} 1/,
    );
  });

  it('renders lag as a histogram labelled by source (count / sum / bucket)', async () => {
    const metrics = new RelayMetrics();
    metrics.recordLagSeconds('subscription.outbox_events', 0.25);
    metrics.recordLagSeconds('subscription.outbox_events', 2.5);

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE outbox_relay_lag_seconds histogram/);
    expect(out).toMatch(
      /outbox_relay_lag_seconds_count\{[^}]*source="subscription\.outbox_events"[^}]*\} 2/,
    );
    expect(out).toMatch(/outbox_relay_lag_seconds_sum/);
    expect(out).toMatch(/outbox_relay_lag_seconds_bucket/);
  });

  it('renders per-cycle + per-publish duration as source-labelled histograms', async () => {
    const metrics = new RelayMetrics();
    metrics.recordPollDuration('subscription.outbox_events', 0.004);
    metrics.recordPublishDuration('subscription.outbox_events', 0.001);

    const out = await serializeMetrics();

    expect(out).toMatch(/# TYPE outbox_relay_poll_duration_seconds histogram/);
    expect(out).toMatch(
      /outbox_relay_poll_duration_seconds_count\{[^}]*source="subscription\.outbox_events"[^}]*\} 1/,
    );
    expect(out).toMatch(/# TYPE outbox_relay_publish_duration_seconds histogram/);
    expect(out).toMatch(
      /outbox_relay_publish_duration_seconds_count\{[^}]*source="subscription\.outbox_events"[^}]*\} 1/,
    );
  });

  it('is safe to construct + record when metrics are not initialized', async () => {
    // No initMetrics in this case — getMeter returns the OTel no-op meter,
    // so recording must not throw (unit tests + CLI contexts rely on this).
    await shutdownMetrics();
    const metrics = new RelayMetrics();
    expect(() => {
      metrics.recordPoll('subscription.outbox_events', 'ok');
      metrics.recordDispatched('subscription.outbox_events', 'subscription.activated');
      metrics.recordFailed('subscription.outbox_events', 'subscription.activated', 'unknown');
      metrics.recordDeadLettered('subscription.outbox_events', 'subscription.activated');
      metrics.recordLagSeconds('subscription.outbox_events', 1.2);
      metrics.recordPollDuration('subscription.outbox_events', 0.01);
      metrics.recordPublishDuration('subscription.outbox_events', 0.001);
    }).not.toThrow();
  });
});

describe('classifyFailureReason', () => {
  it('maps connection / timeout errors to bus_unavailable', () => {
    expect(classifyFailureReason('connect ECONNREFUSED 127.0.0.1:6379')).toBe('bus_unavailable');
    expect(classifyFailureReason('Connection is closed.')).toBe('bus_unavailable');
    expect(classifyFailureReason('Command timed out')).toBe('bus_unavailable');
    expect(classifyFailureReason('read ECONNRESET')).toBe('bus_unavailable');
    expect(classifyFailureReason('getaddrinfo ENOTFOUND redis')).toBe('bus_unavailable');
  });

  it('maps Redis command rejections to publish_rejected', () => {
    expect(
      classifyFailureReason('WRONGTYPE Operation against a key holding the wrong kind of value'),
    ).toBe('publish_rejected');
    expect(classifyFailureReason('OOM command not allowed when used memory > maxmemory')).toBe(
      'publish_rejected',
    );
    expect(classifyFailureReason("READONLY You can't write against a read only replica.")).toBe(
      'publish_rejected',
    );
  });

  it('falls back to unknown for unrecognised messages', () => {
    expect(classifyFailureReason('something entirely unexpected happened')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyFailureReason('Econnrefused')).toBe('bus_unavailable');
  });
});
