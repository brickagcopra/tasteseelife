import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'service-identity:kyc';

/**
 * Outcome label for `kyc_sessions_created_total`. The three named in
 * the TS-026-followup-7 acceptance map 1:1 to `KycService.startSession`'s
 * `Result`: `ok` (a Stripe session was minted + a row inserted),
 * `stripe_unavailable` (Stripe rejected / timed out the create call), and
 * `invalid_request` (empty userId). `error` is the catch-all for the
 * unexpected throw path (e.g. a `P2002` on the `external_id` unique
 * constraint) so a 500 is still visible on the scrape surface rather than
 * silently absent. All values are fixed string literals — cardinality is
 * bounded, no PII (CLAUDE.md §10).
 */
export type KycSessionOutcome = 'ok' | 'stripe_unavailable' | 'invalid_request' | 'error';

/**
 * Outcome label for `kyc_webhook_applied_total` +
 * `kyc_webhook_apply_duration_seconds`. `applied` / `replayed` /
 * `session_mismatch` are the three named in the acceptance (the success +
 * the two benign no-op outcomes service-identity reports back to the
 * dispatcher); `invalid_request` covers the empty-eventId / empty-session-id
 * guard; `error` is the unexpected-throw catch-all. Bounded, no PII.
 */
export type KycWebhookOutcome =
  | 'applied'
  | 'replayed'
  | 'session_mismatch'
  | 'invalid_request'
  | 'error';

/**
 * The Stripe Identity event types we recognise, mapped to a short,
 * bounded `event_type` label. Anything else collapses to `other` so an
 * unexpected (or attacker-supplied) event type string can never blow up
 * the metric cardinality — the label space is fixed at compile time
 * (CLAUDE.md §10). Mirrors the catalog in `mapEventTypeToStatus`.
 */
const KNOWN_EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  'identity.verification_session.created': 'created',
  'identity.verification_session.processing': 'processing',
  'identity.verification_session.verified': 'verified',
  'identity.verification_session.requires_input': 'requires_input',
  'identity.verification_session.canceled': 'canceled',
  'identity.verification_session.redacted': 'redacted',
};

/**
 * Normalise a raw Stripe `event.type` to the bounded `event_type` metric
 * label. Exported for the unit test that pins the cardinality contract.
 */
export function normalizeKycEventTypeLabel(eventType: string): string {
  return KNOWN_EVENT_TYPE_LABELS[eventType] ?? 'other';
}

/**
 * service-identity's KYC-domain Prometheus instruments (TS-026-followup-7).
 *
 * Three instruments cover the two write paths of `KycService`:
 *
 *   - `kyc_sessions_created_total{outcome}` — every `startSession` call,
 *     partitioned by outcome. A rising `stripe_unavailable` rate is the
 *     leading indicator of a Stripe outage or a rotated `STRIPE_SECRET_KEY`;
 *     a rising `error` rate points at the `external_id` unique-constraint
 *     path (a duplicated Stripe session id, which should never happen).
 *   - `kyc_webhook_applied_total{event_type,outcome}` — every internal
 *     dispatch from service-webhook, partitioned by the Stripe event type
 *     and the apply outcome. `session_mismatch` surfaces sessions created
 *     outside our system (e.g. via the Stripe Dashboard); a `replayed`
 *     spike means the dispatcher is resending acks that aren't landing.
 *   - `kyc_webhook_apply_duration_seconds{outcome}` — latency of the
 *     `applyWebhookEvent` path (the findUnique + the encrypt + the update),
 *     bucketed by outcome so the cheap invalid_request / session_mismatch
 *     short-circuits don't skew the applied-path histogram.
 *
 * Label cardinality is bounded by construction — `outcome` is a fixed
 * string-literal union and `event_type` is normalised through
 * {@link normalizeKycEventTypeLabel}; neither is ever derived from the
 * (encrypted-at-rest) Stripe payload, the userId, or any other PII
 * (CLAUDE.md §3.9 / §10).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK. Mirrors the
 * `IpCircuitBreakerService` (TS-025-followup-1a) + `WebhookMetrics`
 * (TS-041a-followup-4) domain-instrument shape.
 */
@Injectable()
export class KycMetrics {
  private readonly sessionsCreated: Counter;
  private readonly webhookApplied: Counter;
  private readonly webhookApplyDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.sessionsCreated = meter.createCounter('kyc_sessions_created_total', {
      description:
        'Total KYC verification sessions created, by outcome (ok / stripe_unavailable / invalid_request / error).',
    });
    this.webhookApplied = meter.createCounter('kyc_webhook_applied_total', {
      description:
        'Total KYC webhook events applied, by Stripe event type and outcome (applied / replayed / session_mismatch / invalid_request / error).',
    });
    this.webhookApplyDuration = meter.createHistogram('kyc_webhook_apply_duration_seconds', {
      description: 'Latency of KYC applyWebhookEvent processing, in seconds, by outcome.',
      unit: 's',
    });
  }

  /** Record one `startSession` outcome. */
  recordSessionCreated(outcome: KycSessionOutcome): void {
    this.sessionsCreated.add(1, { outcome });
  }

  /** Record one `applyWebhookEvent` outcome (counter + latency histogram). */
  recordWebhookApplied(eventType: string, outcome: KycWebhookOutcome, seconds: number): void {
    const event_type = normalizeKycEventTypeLabel(eventType);
    this.webhookApplied.add(1, { event_type, outcome });
    this.webhookApplyDuration.record(seconds, { outcome });
  }
}
