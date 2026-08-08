import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

import type { ApplicationsServiceFailure } from './applications.service';
import type { BackgroundCheckServiceFailure } from './background-check.service';

const METER_NAME = 'service-provider:applications';

/**
 * Outcome label for `provider_applications_submitted_total`. `ok` is a
 * successful submission (providers + provider_applications +
 * provider_background_checks rows landed). The remainder mirror
 * {@link ApplicationsServiceFailure}'s `reason` discriminants 1:1:
 * `already_applied` (the active-application short-circuit),
 * `invalid_request` (an empty userId / displayName / timeZone),
 * `checkr_invalid_applicant` (Checkr rejected the applicant shape →
 * 400), `checkr_unavailable` (Checkr API failure → 503), plus the
 * background-check reasons that the union admits but the submit path
 * does not realistically produce (`record_not_found` / `report_mismatch`
 * / `event_replay`). `error` is the unexpected-throw catch-all so a 500
 * stays visible on the scrape surface. All values are fixed string
 * literals — cardinality is bounded, no PII (CLAUDE.md §10).
 */
export type ProviderApplicationSubmitOutcome =
  | 'ok'
  | 'invalid_request'
  | 'already_applied'
  | 'record_not_found'
  | 'report_mismatch'
  | 'event_replay'
  | 'checkr_unavailable'
  | 'checkr_invalid_applicant'
  | 'error';

/**
 * Outcome label for `provider_background_check_webhook_applied_total` +
 * `provider_background_check_webhook_apply_duration_seconds`. `applied` /
 * `replayed` / `report_mismatch` are the three named in the acceptance
 * (the success + the two benign no-op outcomes the controller reports
 * back to the dispatcher); `invalid_request` covers the empty-eventId /
 * empty-report-id guard; `error` is the unexpected-throw catch-all
 * (a Prisma update failure, a cipher error). The `record_not_found` /
 * `checkr_*` arms of {@link BackgroundCheckServiceFailure} never fire on
 * the apply path — they fold into `error`. Bounded, no PII.
 */
export type ProviderBackgroundCheckWebhookOutcome =
  | 'applied'
  | 'replayed'
  | 'report_mismatch'
  | 'invalid_request'
  | 'error';

/**
 * The Checkr `report.*` event types we recognise, mapped to a short,
 * bounded `event_type` label. The contract validates `eventType` only as
 * `z.string().min(1).max(255)`, so a drifted (or attacker-supplied) value
 * could otherwise blow up the metric cardinality — anything not in this
 * catalog collapses to `other` so the label space is fixed at compile time
 * (CLAUDE.md §10 / §17.2). Mirrors `normalizeKycEventTypeLabel`.
 */
const KNOWN_CHECKR_EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  'report.created': 'created',
  'report.updated': 'updated',
  'report.upgraded': 'upgraded',
  'report.completed': 'completed',
  'report.resumed': 'resumed',
  'report.canceled': 'canceled',
  'report.suspended': 'suspended',
  'report.disputed': 'disputed',
  'report.engaged': 'engaged',
  'report.pending': 'pending',
  'report.post_adverse_action': 'post_adverse_action',
};

/**
 * Normalise a raw Checkr `event.type` to the bounded `event_type` metric
 * label. Exported for the unit test that pins the cardinality contract.
 */
export function normalizeCheckrEventTypeLabel(eventType: string): string {
  return KNOWN_CHECKR_EVENT_TYPE_LABELS[eventType] ?? 'other';
}

/**
 * Map an `ApplicationsServiceFailure` to its bounded
 * `provider_applications_submitted_total` outcome label. The reason
 * discriminants are themselves the bounded union members, so the mapper
 * is the identity on `reason` — typed so a new failure reason that is not
 * a {@link ProviderApplicationSubmitOutcome} member fails the call-site
 * type-check (the cardinality contract). Mirrors `startSessionOutcome`
 * (TS-026-followup-7).
 */
export function submitApplicationOutcome(
  failure: ApplicationsServiceFailure,
): ProviderApplicationSubmitOutcome {
  return failure.reason;
}

/**
 * Map a `BackgroundCheckServiceFailure` to its bounded
 * `provider_background_check_webhook_applied_total` outcome label.
 * `event_replay` → `replayed`; `report_mismatch` / `invalid_request`
 * pass through; the remaining arms (`record_not_found`, `checkr_*`) do
 * not fire on the apply path and fold into `error`. Mirrors
 * `applyWebhookOutcome` (TS-026-followup-7).
 */
export function applyWebhookOutcome(
  failure: BackgroundCheckServiceFailure,
): ProviderBackgroundCheckWebhookOutcome {
  switch (failure.reason) {
    case 'event_replay':
      return 'replayed';
    case 'report_mismatch':
      return 'report_mismatch';
    case 'invalid_request':
      return 'invalid_request';
    case 'record_not_found':
    case 'checkr_unavailable':
    case 'checkr_invalid_applicant':
      return 'error';
  }
}

/**
 * service-provider's application-domain Prometheus instruments
 * (TS-051-followup-7).
 *
 * Three instruments cover the two write paths of the application surface:
 *
 *   - `provider_applications_submitted_total{outcome}` — every
 *     `ApplicationsService.submitApplication` call. A rising
 *     `checkr_unavailable` rate is the leading indicator of a Checkr
 *     outage or a rotated `CHECKR_API_KEY`; a rising `already_applied`
 *     rate is the normal duplicate-submit-retry signal from the portal.
 *   - `provider_background_check_webhook_applied_total{event_type,outcome}`
 *     — every internal dispatch from service-webhook applied by
 *     `BackgroundCheckService.applyWebhookEvent`, partitioned by the
 *     (normalised) Checkr event type and the apply outcome.
 *     `report_mismatch` surfaces reports created outside our system;
 *     a `replayed` spike means the dispatcher is resending acks that
 *     aren't landing.
 *   - `provider_background_check_webhook_apply_duration_seconds{outcome}`
 *     — latency of the `applyWebhookEvent` path (findUnique + encrypt +
 *     update), bucketed by outcome so the cheap invalid_request /
 *     report_mismatch short-circuits don't skew the applied-path
 *     histogram.
 *
 * Label cardinality is bounded by construction — `outcome` is a fixed
 * string-literal union and `event_type` is normalised through
 * {@link normalizeCheckrEventTypeLabel}. Neither is ever derived from the
 * applicant PII (which flows to Checkr and is never persisted), the
 * encrypted-at-rest Checkr payload, the candidate / report id, or the
 * userId (CLAUDE.md §3.9 / §10).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK. Mirrors the
 * `KycMetrics` (TS-026-followup-7) domain-instrument shape.
 */
@Injectable()
export class ApplicationsMetrics {
  private readonly submitted: Counter;
  private readonly webhookApplied: Counter;
  private readonly webhookApplyDuration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.submitted = meter.createCounter('provider_applications_submitted_total', {
      description: 'Total provider-application submissions, by outcome.',
    });
    this.webhookApplied = meter.createCounter('provider_background_check_webhook_applied_total', {
      description:
        'Total Checkr background-check webhook events applied, by Checkr event type and outcome.',
    });
    this.webhookApplyDuration = meter.createHistogram(
      'provider_background_check_webhook_apply_duration_seconds',
      {
        description: 'Latency of applyWebhookEvent processing, in seconds, by outcome.',
        unit: 's',
      },
    );
  }

  /** Record one `submitApplication` outcome. */
  recordSubmitted(outcome: ProviderApplicationSubmitOutcome): void {
    this.submitted.add(1, { outcome });
  }

  /** Record one `applyWebhookEvent` outcome (counter + latency histogram). */
  recordWebhookApplied(
    eventType: string,
    outcome: ProviderBackgroundCheckWebhookOutcome,
    seconds: number,
  ): void {
    const event_type = normalizeCheckrEventTypeLabel(eventType);
    this.webhookApplied.add(1, { event_type, outcome });
    this.webhookApplyDuration.record(seconds, { outcome });
  }
}
