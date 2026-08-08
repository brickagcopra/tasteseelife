import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

const METER_NAME = 'service-trust-safety:incident-pager';

/**
 * Outcome label for `trust_safety_incident_pages_total`. Mirrors the
 * `PagerDutyClient` result union exactly, so a fourth result kind added to
 * the shared package becomes a compile error here rather than a silently
 * unrecorded outcome.
 *
 *   - `sent` — the provider accepted the enqueue.
 *   - `skipped_unconfigured` — no routing key in this environment.
 *   - `failed` — the provider rejected it or the call did not complete.
 */
export type IncidentPageOutcome = 'sent' | 'skipped_unconfigured' | 'failed';

/**
 * The on-call paging instrument (TS-306-followup-1c).
 *
 * TS-306's `IncidentPagerService` doc-block said every outcome was "logged
 * and metered by kind". Only the first half was true — this service had no
 * meter provider at all — and this class is what makes the sentence honest.
 *
 * `trust_safety_incident_pages_total{outcome}` is the only signal that can
 * answer the question the pager exists for: **did a critical incident
 * actually wake somebody?** The three outcomes fail in different directions
 * and must not blur:
 *
 *   - A rising `failed` rate is an outage in the paging path while incidents
 *     keep arriving — the durable incident is still written, so nothing else
 *     on the platform looks wrong.
 *   - A steady `skipped_unconfigured` is an environment that intends to page
 *     and has no routing key. It logs at WARN for that reason, and the
 *     counter is what turns "somebody would have to read the logs" into an
 *     alertable series.
 *   - A flat `sent` of zero over a period when `trust_safety_incidents_opened_total{severity="critical"}`
 *     moved is the pair that catches a broken call site rather than a broken
 *     provider.
 *
 * No incident id, no category, no free text — a page's whole design is that
 * the operational identifiers go to the responder's console behind
 * authorisation, not into third-party or telemetry channels (CLAUDE.md §3.9).
 * `outcome` is a closed set of three literals: three series, bounded.
 */
@Injectable()
export class IncidentPagerMetrics {
  private readonly pages: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.pages = meter.createCounter('trust_safety_incident_pages_total', {
      description:
        'Total on-call page attempts for critical trust & safety incidents, by outcome (sent / skipped_unconfigured / failed).',
    });
  }

  /** Record one page attempt. Not called for non-critical incidents — those are not attempts. */
  recordPage(outcome: IncidentPageOutcome): void {
    this.pages.add(1, { outcome });
  }
}
