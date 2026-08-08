import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BookingMetrics } from './booking-metrics';

/**
 * Full-surface tests for the domain counters (TS-060-followup-4): boot a
 * MeterProvider, record through the public methods, and assert the
 * serialized Prometheus document carries the expected series + labels. This
 * proves the counters are wired to the global meter and that the label sets
 * are exactly what the dashboards/alerts query — not just that a method was
 * called. Mirrors the webhook-metrics.test.ts shape (TS-041a-followup-4).
 *
 * A long export interval (1h) keeps the periodic reader's background sweep
 * from racing the inline `collect()` inside `serializeMetrics()`.
 */
describe('BookingMetrics', () => {
  let metrics: BookingMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-booking-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    metrics = new BookingMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records a created booking under the outcome="created" series', async () => {
    metrics.recordCreated('created');
    metrics.recordCreated('created');

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE booking_created_total counter/);
    expect(out).toMatch(/booking_created_total\{[^}]*outcome="created"[^}]*\} 2/);
  });

  it('partitions create outcomes on distinct series', async () => {
    metrics.recordCreated('tier_gating_blocked');
    metrics.recordCreated('invalid_request');
    metrics.recordCreated('outbox_validation_failed');

    const out = await serializeMetrics();
    expect(out).toMatch(/booking_created_total\{[^}]*outcome="tier_gating_blocked"[^}]*\} 1/);
    expect(out).toMatch(/booking_created_total\{[^}]*outcome="invalid_request"[^}]*\} 1/);
    expect(out).toMatch(/booking_created_total\{[^}]*outcome="outbox_validation_failed"[^}]*\} 1/);
  });

  it('records a transition carrying from/to/outcome labels', async () => {
    metrics.recordTransition('confirmed', 'in_progress', 'applied');

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE booking_status_transition_total counter/);
    expect(out).toMatch(
      /booking_status_transition_total\{[^}]*from="confirmed"[^}]*to="in_progress"[^}]*outcome="applied"[^}]*\} 1/,
    );
  });

  it('records the `unknown` from-sentinel for pre-load guard rejections', async () => {
    metrics.recordTransition('unknown', 'confirmed', 'invalid_request');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /booking_status_transition_total\{[^}]*from="unknown"[^}]*to="confirmed"[^}]*outcome="invalid_request"[^}]*\} 1/,
    );
  });

  it('records an accept-window-expired transition outcome', async () => {
    metrics.recordTransition('pending', 'confirmed', 'accept_window_expired');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /booking_status_transition_total\{[^}]*outcome="accept_window_expired"[^}]*\} 1/,
    );
  });

  it('records completion outcomes on an independent series', async () => {
    metrics.recordCompletion('completed');
    metrics.recordCompletion('invalid_transition');

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE booking_completion_total counter/);
    expect(out).toMatch(/booking_completion_total\{[^}]*outcome="completed"[^}]*\} 1/);
    expect(out).toMatch(/booking_completion_total\{[^}]*outcome="invalid_transition"[^}]*\} 1/);
  });

  it('records the check-in `already_recorded` UNIQUE-collision outcome on both funnels', async () => {
    // A `check_out` (`to=completed`) UNIQUE collision fans onto the completion
    // funnel's `already_recorded` arm via `recordTransitionOutcome`.
    metrics.recordTransitionOutcome('in_progress', 'completed', 'already_recorded');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /booking_status_transition_total\{[^}]*to="completed"[^}]*outcome="already_recorded"[^}]*\} 1/,
    );
    expect(out).toMatch(/booking_completion_total\{[^}]*outcome="already_recorded"[^}]*\} 1/);
  });

  it('recordTransitionOutcome fans a completed transition onto BOTH the transition and completion funnels', async () => {
    metrics.recordTransitionOutcome('in_progress', 'completed', 'applied');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /booking_status_transition_total\{[^}]*from="in_progress"[^}]*to="completed"[^}]*outcome="applied"[^}]*\} 1/,
    );
    // The transition's `applied` success is named `completed` on the funnel.
    expect(out).toMatch(/booking_completion_total\{[^}]*outcome="completed"[^}]*\} 1/);
  });

  it('recordTransitionOutcome leaves the completion funnel untouched for non-completed targets', async () => {
    metrics.recordTransitionOutcome('confirmed', 'in_progress', 'applied');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /booking_status_transition_total\{[^}]*to="in_progress"[^}]*outcome="applied"[^}]*\} 1/,
    );
    // No completion series should exist — a check_in is not a completion.
    expect(out).not.toMatch(/booking_completion_total\{/);
  });

  it('recordTransitionOutcome does not fan an accept-window-expired confirm onto the completion funnel', async () => {
    // `accept_window_expired` only arises with `to=confirmed`; guard against a
    // future regression that lets it reach the completion funnel.
    metrics.recordTransitionOutcome('pending', 'confirmed', 'accept_window_expired');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /booking_status_transition_total\{[^}]*outcome="accept_window_expired"[^}]*\} 1/,
    );
    expect(out).not.toMatch(/booking_completion_total\{/);
  });

  it('records a cancellation carrying the categorical reason', async () => {
    metrics.recordCancellation('welfare_concern');
    metrics.recordCancellation('family_request');

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE booking_cancellation_total counter/);
    expect(out).toMatch(/booking_cancellation_total\{[^}]*reason="welfare_concern"[^}]*\} 1/);
    expect(out).toMatch(/booking_cancellation_total\{[^}]*reason="family_request"[^}]*\} 1/);
  });

  it('records the `unspecified` cancellation sentinel when no reason was supplied', async () => {
    metrics.recordCancellation('unspecified');

    const out = await serializeMetrics();
    expect(out).toMatch(/booking_cancellation_total\{[^}]*reason="unspecified"[^}]*\} 1/);
  });

  it('constructs without a booted SDK (no-op meter fallback)', async () => {
    // Tear the harness provider down to simulate the OTEL_METRICS_ENABLED=false
    // path: getMeter returns a usable no-op meter, so construction + recording
    // must not throw.
    await shutdownMetrics();
    const offline = new BookingMetrics();
    expect(() => offline.recordCreated('created')).not.toThrow();
    expect(() => offline.recordTransition('pending', 'confirmed', 'applied')).not.toThrow();
    expect(() =>
      offline.recordTransitionOutcome('in_progress', 'completed', 'applied'),
    ).not.toThrow();
    expect(() => offline.recordCompletion('completed')).not.toThrow();
    expect(() => offline.recordCancellation('other')).not.toThrow();
  });
});
