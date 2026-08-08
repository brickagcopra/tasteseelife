import { Inject, Injectable, Logger } from '@nestjs/common';
import { PagerDutyClient } from '@taste-and-see/nest-pagerduty';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import type { IncidentRow } from '../repositories/incident.repository';
import { IncidentPagerMetrics } from './incident-pager-metrics';

/**
 * Pages the on-call trust & safety supervisor when a `critical` incident
 * opens (TS-306; PRD §10.14; PDD §16.1, §20.5).
 *
 * Uses the shared `@taste-and-see/nest-pagerduty` client extracted in
 * TS-302b — this service is its second consumer, and the reason the package
 * makes `source` a required option: a welfare page that reads as coming from
 * `service-concierge` sends the responder to the wrong console.
 *
 * **Only `critical`.** The other three severities have SLA budgets measured
 * in hours (8 / 24 / 72 — see `sla.ts`) and belong to the ops queue, not to
 * someone's phone at 3am. Paging on `high` would make the pager the queue,
 * and a pager that fires constantly is a pager nobody answers. The
 * SLA-BREACH path — "a high-severity incident nobody has touched in 8 hours"
 * — is a genuinely different signal and is carved to TS-306-followup-1,
 * where it belongs to a scheduled sweep rather than to intake.
 *
 * **Best-effort, never throws.** Called AFTER the incident transaction has
 * committed. The incident is the durable source of truth with its SLA clock
 * already running; a paging failure must never roll it back or fail the
 * filer's request. Every outcome is logged and metered by kind
 * (`trust_safety_incident_pages_total{outcome}`) — the metering half of that
 * sentence was aspirational until TS-306-followup-1c wired this service's
 * meter provider, because `getMeter` returns a no-op when `initMetrics` was
 * never called and the counter would have read as instrumentation while
 * reporting nothing.
 *
 * **No free text in the payload.** The custom details carry ids, category,
 * severity, and deadlines only. An incident `description` is a family's
 * account of what happened to a named senior — PII/PHI that must not land in
 * a third-party paging system (CLAUDE.md §3.9). The summary tells the
 * responder what kind of thing it is; the deep link takes them to the
 * console where the detail lives behind authorisation.
 */
@Injectable()
export class IncidentPagerService {
  private readonly logger = new Logger(IncidentPagerService.name);

  constructor(
    private readonly pagerDuty: PagerDutyClient,
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly metrics: IncidentPagerMetrics,
  ) {}

  /**
   * Page on-call if the incident warrants it. A no-op for non-critical
   * severities, so callers can invoke it unconditionally.
   */
  async pageIfCritical(incident: IncidentRow): Promise<void> {
    if (incident.severity !== 'critical') return;

    const result = await this.pagerDuty.enqueue({
      // Keyed on the incident so a retried intake, or a re-page after a
      // transient failure, collapses onto one alert rather than waking the
      // responder twice for one incident.
      dedupKey: `trust-safety-incident-${incident.id}`,
      summary: `[Taste & See] CRITICAL trust & safety incident (${incident.category}) — ${incident.id}`,
      severity: 'critical',
      customDetails: this.buildDetails(incident),
    });

    // Recorded before the branch so no outcome can be added later without
    // one: `result.kind` and the metric's label set are the same union
    // (TS-306-followup-1c).
    this.metrics.recordPage(result.kind);

    switch (result.kind) {
      case 'sent':
        this.logger.log(
          `trust_safety.incident.paged ${JSON.stringify({
            incidentId: incident.id,
            category: incident.category,
            dedupKey: result.dedupKey,
          })}`,
        );
        return;
      case 'skipped_unconfigured':
        // Warn, not debug: a critical incident opened and nobody was woken.
        // In an environment that intends to page, this line is the outage.
        this.logger.warn(
          `trust_safety.incident.page_skipped_unconfigured ${JSON.stringify({
            incidentId: incident.id,
          })}`,
        );
        return;
      case 'failed':
        this.logger.error(
          `trust_safety.incident.page_failed ${JSON.stringify({
            incidentId: incident.id,
            detail: result.detail,
          })}`,
        );
        return;
    }
  }

  /** Operational identifiers only — never the report body (CLAUDE.md §3.9). */
  private buildDetails(incident: IncidentRow): Record<string, string> {
    const details: Record<string, string> = {
      incidentId: incident.id,
      category: incident.category,
      severity: incident.severity,
      source: incident.source,
      openedAt: incident.openedAt.toISOString(),
      slaDueAt: incident.slaDueAt.toISOString(),
    };

    const runbookUrl = this.env.TRUST_SAFETY_RUNBOOK_URL;
    if (runbookUrl !== undefined) details['runbookUrl'] = runbookUrl;

    const consoleBase = this.env.TRUST_SAFETY_OPS_CONSOLE_BASE_URL;
    if (consoleBase !== undefined) {
      details['incidentUrl'] =
        `${consoleBase.replace(/\/+$/, '')}/trust-safety/incidents/${incident.id}`;
    }

    return details;
  }
}
