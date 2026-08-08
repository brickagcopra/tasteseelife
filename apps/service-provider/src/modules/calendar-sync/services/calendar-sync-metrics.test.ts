import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CalendarSyncMetrics,
  disconnectFailureOutcome,
  syncFailureOutcome,
  type CalendarDisconnectOutcome,
  type CalendarSyncOutcome,
} from './calendar-sync-metrics';

/**
 * Cardinality-contract mappers (TS-206-followup-8). Neither mapper is a
 * pure identity — `syncFailureOutcome` collapses the two Google-failure
 * reasons onto the acceptance-named `auth_rejected` / `transient` labels,
 * and `disconnectFailureOutcome` collapses the unreachable reasons onto
 * `error`. Both switches are exhaustive over the shared
 * `CalendarSyncFailure` union, so a new failure reason can't silently
 * widen the metric label space: the call site fails to type-check.
 */
describe('syncFailureOutcome', () => {
  it.each<[reason: string, expected: CalendarSyncOutcome]>([
    ['sync_auth_rejected', 'auth_rejected'],
    ['sync_failed', 'transient'],
    ['not_connected', 'not_connected'],
    ['invalid_request', 'invalid_request'],
    ['not_configured', 'not_configured'],
    ['not_found', 'not_found'],
    ['forbidden', 'forbidden'],
    ['outbox_validation_failed', 'outbox_validation_failed'],
    ['exchange_failed', 'transient'],
  ])('maps sync failure reason "%s" to "%s"', (reason, expected) => {
    expect(syncFailureOutcome({ reason } as never)).toBe(expected);
  });
});

describe('disconnectFailureOutcome', () => {
  it.each<[reason: string, expected: CalendarDisconnectOutcome]>([
    ['invalid_request', 'invalid_request'],
    ['not_configured', 'not_configured'],
    ['not_found', 'not_found'],
    ['forbidden', 'forbidden'],
    ['outbox_validation_failed', 'outbox_validation_failed'],
    // Reasons the disconnect path cannot produce collapse to `error`.
    ['not_connected', 'error'],
    ['sync_auth_rejected', 'error'],
    ['sync_failed', 'error'],
    ['exchange_failed', 'error'],
  ])('maps disconnect failure reason "%s" to "%s"', (reason, expected) => {
    expect(disconnectFailureOutcome({ reason } as never)).toBe(expected);
  });
});

/**
 * CalendarSyncMetrics instruments (TS-206-followup-8; CLAUDE.md §10).
 * Init a real MeterProvider, drive the recorder, assert the Prometheus
 * exposition. Mirrors the ProviderPricingMetrics test shape.
 */
describe('CalendarSyncMetrics — Prometheus exposition', () => {
  let metrics: CalendarSyncMetrics;

  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
    metrics = new CalendarSyncMetrics();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a connected outcome', async () => {
    metrics.recordConnect('connected');
    const out = await serializeMetrics();
    expect(out).toMatch(/calendar_connect_total\{[^}]*outcome="connected"[^}]*\} 1/);
  });

  it('counts distinct connect outcomes separately', async () => {
    metrics.recordConnect('connected_sync_error');
    metrics.recordConnect('consent_declined');
    const out = await serializeMetrics();
    expect(out).toMatch(/calendar_connect_total\{[^}]*outcome="connected_sync_error"[^}]*\} 1/);
    expect(out).toMatch(/calendar_connect_total\{[^}]*outcome="consent_declined"[^}]*\} 1/);
  });

  it('counts the three load-bearing sync outcomes separately', async () => {
    metrics.recordSync('ok');
    metrics.recordSync('auth_rejected');
    metrics.recordSync('transient');
    const out = await serializeMetrics();
    expect(out).toMatch(/calendar_sync_total\{[^}]*outcome="ok"[^}]*\} 1/);
    expect(out).toMatch(/calendar_sync_total\{[^}]*outcome="auth_rejected"[^}]*\} 1/);
    expect(out).toMatch(/calendar_sync_total\{[^}]*outcome="transient"[^}]*\} 1/);
  });

  it('distinguishes a real disconnect from the idempotent no-op', async () => {
    metrics.recordDisconnect('disconnected');
    metrics.recordDisconnect('already_disconnected');
    const out = await serializeMetrics();
    expect(out).toMatch(/calendar_disconnect_total\{[^}]*outcome="disconnected"[^}]*\} 1/);
    expect(out).toMatch(/calendar_disconnect_total\{[^}]*outcome="already_disconnected"[^}]*\} 1/);
  });

  it('records the external-busy-interval histogram by phase', async () => {
    metrics.recordExternalBusyIntervals('connect', 3);
    metrics.recordExternalBusyIntervals('sync', 7);
    const out = await serializeMetrics();
    expect(out).toMatch(/calendar_external_busy_intervals_count\{[^}]*phase="connect"[^}]*\} 1/);
    expect(out).toMatch(/calendar_external_busy_intervals_count\{[^}]*phase="sync"[^}]*\} 1/);
  });

  it('records the error catch-all on each counter', async () => {
    metrics.recordConnect('error');
    metrics.recordSync('error');
    metrics.recordDisconnect('error');
    const out = await serializeMetrics();
    expect(out).toMatch(/calendar_connect_total\{[^}]*outcome="error"[^}]*\} 1/);
    expect(out).toMatch(/calendar_sync_total\{[^}]*outcome="error"[^}]*\} 1/);
    expect(out).toMatch(/calendar_disconnect_total\{[^}]*outcome="error"[^}]*\} 1/);
  });

  it('never leaks a providerId / actor id / token / email onto the scrape surface', async () => {
    metrics.recordConnect('connected');
    metrics.recordSync('ok');
    metrics.recordDisconnect('disconnected');
    metrics.recordExternalBusyIntervals('sync', 2);
    const out = await serializeMetrics();
    expect(out).not.toContain('prov_');
    expect(out).not.toContain('user_');
    expect(out).not.toMatch(/refresh/i);
    expect(out).not.toMatch(/@/);
    // `outcome` + `phase` are the only label keys — no id / email / token
    // label ever appears.
    expect(out).not.toMatch(/\bprovider_id="/);
    expect(out).not.toMatch(/\bemail="/);
    expect(out).toMatch(/calendar_connect_total/);
  });
});
