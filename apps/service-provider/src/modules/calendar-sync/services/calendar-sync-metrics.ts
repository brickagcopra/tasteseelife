import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

import type { CalendarSyncFailure } from './calendar-sync.service';

const METER_NAME = 'service-provider:calendar-sync';

/**
 * Outcome label for `calendar_connect_total`. The connect counter records
 * one increment per OAuth-callback completion
 * (`CalendarSyncService.completeConnection` — the point where a
 * connection row is actually established). Each value is a fixed string
 * literal — bounded cardinality, no PII (CLAUDE.md §3.9 / §10 / §17.2):
 *   - `connected` — the callback persisted the connection AND the initial
 *     free/busy pull succeeded.
 *   - `connected_sync_error` — the connection persisted (the refresh
 *     token is valid) but the initial free/busy pull failed; the row
 *     lands with `status=error` and the portal surfaces "first sync
 *     failed, retry".
 *   - `consent_declined` — the provider declined consent at Google (or
 *     Google returned no `code`).
 *   - `provider_mismatch` — the signed state no longer maps to an owned,
 *     live provider row.
 *   - `exchange_failed` — the authorization-code → token exchange failed.
 *   - `persist_failed` — the write transaction rolled back because the
 *     `provider.calendar_synced` outbox payload failed validation.
 *   - `invalid_state` — a forged / expired state (no redirect is
 *     followed; the callback answers 400).
 *   - `not_configured` — the calendar-sync feature is dark (missing env).
 *   - `error` — the unexpected-throw catch-all so a 500 stays visible on
 *     the scrape surface rather than mislabelling the sample.
 */
export type CalendarConnectOutcome =
  | 'connected'
  | 'connected_sync_error'
  | 'consent_declined'
  | 'provider_mismatch'
  | 'exchange_failed'
  | 'persist_failed'
  | 'invalid_state'
  | 'not_configured'
  | 'error';

/**
 * Outcome label for `calendar_sync_total`. The acceptance names the three
 * load-bearing values — `ok` (a successful re-pull), `auth_rejected` (the
 * refresh-token grant is no longer valid → reconsent), and `transient`
 * (a retry-eligible Google failure). The remaining members are the
 * pre-pull guard rejections, bounded 1:1 against the reachable
 * {@link CalendarSyncFailure} reasons on the sync path, plus `error`.
 */
export type CalendarSyncOutcome =
  | 'ok'
  | 'auth_rejected'
  | 'transient'
  | 'not_connected'
  | 'invalid_request'
  | 'not_configured'
  | 'not_found'
  | 'forbidden'
  | 'outbox_validation_failed'
  | 'error';

/**
 * Outcome label for `calendar_disconnect_total`. `disconnected` is a real
 * teardown (the connection + busy mirror were removed); `already_disconnected`
 * is the idempotent no-op (nothing was connected). The remainder are the
 * reachable guard rejections on the disconnect path, plus `error`.
 */
export type CalendarDisconnectOutcome =
  | 'disconnected'
  | 'already_disconnected'
  | 'invalid_request'
  | 'not_configured'
  | 'not_found'
  | 'forbidden'
  | 'outbox_validation_failed'
  | 'error';

/**
 * Phase label for `calendar_external_busy_intervals` — the histogram of
 * how many external busy intervals were mirrored on a write. `connect`
 * is the initial pull at OAuth-callback time; `sync` is a manual re-pull.
 * Bounded two-member union; no PII.
 */
export type CalendarBusyPhase = 'connect' | 'sync';

/**
 * Map a `CalendarSyncFailure` to its bounded {@link CalendarSyncOutcome}
 * label for `calendar_sync_total`. NOT an identity mapper — the two
 * Google-failure reasons collapse onto the acceptance-named labels
 * (`sync_auth_rejected` → `auth_rejected`, `sync_failed` → `transient`);
 * the remainder map 1:1. The switch is exhaustive over the shared
 * `CalendarSyncFailure` union, so a new failure reason fails the
 * type-check until it is given a bounded outcome (the cardinality
 * contract). `exchange_failed` is connect-path-only and never reaches
 * the sync surface — mapped defensively to `transient`.
 */
export function syncFailureOutcome(failure: CalendarSyncFailure): CalendarSyncOutcome {
  switch (failure.reason) {
    case 'sync_auth_rejected':
      return 'auth_rejected';
    case 'sync_failed':
      return 'transient';
    case 'not_connected':
      return 'not_connected';
    case 'invalid_request':
      return 'invalid_request';
    case 'not_configured':
      return 'not_configured';
    case 'not_found':
      return 'not_found';
    case 'forbidden':
      return 'forbidden';
    case 'outbox_validation_failed':
      return 'outbox_validation_failed';
    case 'exchange_failed':
      // Connect-path-only; never produced by syncProvider. Mapped
      // defensively so the switch stays exhaustive.
      return 'transient';
  }
}

/**
 * Map a `CalendarSyncFailure` to its bounded
 * {@link CalendarDisconnectOutcome} label for `calendar_disconnect_total`.
 * Exhaustive over the shared union; the reasons the disconnect path
 * cannot produce (`not_connected` — disconnect treats a missing
 * connection as the idempotent `already_disconnected` success, plus the
 * sync / exchange Google failures) collapse to `error` so an unexpected
 * shape stays visible rather than mislabelling the sample.
 */
export function disconnectFailureOutcome(failure: CalendarSyncFailure): CalendarDisconnectOutcome {
  switch (failure.reason) {
    case 'invalid_request':
      return 'invalid_request';
    case 'not_configured':
      return 'not_configured';
    case 'not_found':
      return 'not_found';
    case 'forbidden':
      return 'forbidden';
    case 'outbox_validation_failed':
      return 'outbox_validation_failed';
    case 'not_connected':
    case 'sync_auth_rejected':
    case 'sync_failed':
    case 'exchange_failed':
      return 'error';
  }
}

/**
 * service-provider's calendar-sync Prometheus instruments
 * (TS-206-followup-8).
 *
 * Four instruments cover the calendar-sync surface:
 *
 *   - `calendar_connect_total{outcome}` — every OAuth-callback completion
 *     (`completeConnection`). A rising `consent_declined` rate is normal
 *     drop-off; a rising `exchange_failed` / `persist_failed` rate is a
 *     real connect regression; `connected_sync_error` flags providers who
 *     linked an account whose first free/busy pull failed.
 *   - `calendar_sync_total{outcome}` — every manual re-pull
 *     (`syncProvider`). A rising `auth_rejected` rate means providers'
 *     grants are lapsing (reconsent needed); a rising `transient` rate is
 *     a Google-side availability signal.
 *   - `calendar_disconnect_total{outcome}` — every disconnect.
 *   - `calendar_external_busy_intervals{phase}` — the distribution of how
 *     many external busy intervals were mirrored per write, split by
 *     `connect` (initial pull) vs `sync` (re-pull). Surfaces calendars
 *     that load the union work; the `_count` doubles as the
 *     successful-mirror count per phase.
 *
 * Label cardinality is bounded by construction — `outcome` is a fixed
 * string-literal union mapped through {@link syncFailureOutcome} /
 * {@link disconnectFailureOutcome} for the failure paths, and `phase` is
 * a two-member union. No label is ever derived from a providerId, actor
 * userId, refresh token, or connected-account email (CLAUDE.md §3.9 /
 * §10 / §17.2).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK. Mirrors the
 * `ProviderPricingMetrics` (TS-204-followup-4) domain-instrument shape.
 */
@Injectable()
export class CalendarSyncMetrics {
  private readonly connectTotal: Counter;
  private readonly syncTotal: Counter;
  private readonly disconnectTotal: Counter;
  private readonly externalBusyIntervals: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.connectTotal = meter.createCounter('calendar_connect_total', {
      description: 'Total external-calendar connect-callback completions, by outcome.',
    });
    this.syncTotal = meter.createCounter('calendar_sync_total', {
      description: 'Total external-calendar manual re-syncs, by outcome.',
    });
    this.disconnectTotal = meter.createCounter('calendar_disconnect_total', {
      description: 'Total external-calendar disconnects, by outcome.',
    });
    this.externalBusyIntervals = meter.createHistogram('calendar_external_busy_intervals', {
      description: 'External busy intervals mirrored per write, by phase (connect|sync).',
      unit: '{intervals}',
    });
  }

  /** Record one `completeConnection` outcome. */
  recordConnect(outcome: CalendarConnectOutcome): void {
    this.connectTotal.add(1, { outcome });
  }

  /** Record one `syncProvider` outcome. */
  recordSync(outcome: CalendarSyncOutcome): void {
    this.syncTotal.add(1, { outcome });
  }

  /** Record one `disconnect` outcome. */
  recordDisconnect(outcome: CalendarDisconnectOutcome): void {
    this.disconnectTotal.add(1, { outcome });
  }

  /** Record the external-busy-interval count mirrored on a connect / sync write. */
  recordExternalBusyIntervals(phase: CalendarBusyPhase, count: number): void {
    this.externalBusyIntervals.record(count, { phase });
  }
}
