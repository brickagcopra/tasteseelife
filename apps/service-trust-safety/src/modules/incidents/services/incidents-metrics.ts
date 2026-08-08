import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

import type { IncidentCategory, IncidentSeverity, IncidentSource } from '../incident-enums';

const METER_NAME = 'service-trust-safety:incidents';

/**
 * The intake instrument (TS-306-followup-1c; CLAUDE.md §10 — every new
 * endpoint adds at least one custom metric).
 *
 * `trust_safety_incidents_opened_total{source,severity,category}` counts
 * every incident this service opens, on every path: the family/senior
 * "Report a concern" form, the provider form, the concierge on-behalf
 * route, and the three system detectors (background-check adverse finding,
 * impossible travel, mass cancellation). The `source` label is what makes
 * the series worth having — a detector that starts firing on ordinary life
 * and a family reporting more concerns are the same line without it, and
 * they call for opposite responses. `severity` is the second axis because
 * `high` and `critical` carry consequences beyond the queue (a booking hold
 * and a page respectively), so a shift in the severity mix is a shift in
 * how much care the platform is suspending.
 *
 * **Every label is a closed enum** — 5 sources × 4 severities × 4
 * categories, 80 series at the ceiling. No incident id, no household /
 * senior / provider id, and no description: this whole track exists because
 * the report body is a family's account of a named senior, and a metrics
 * backend is a channel that replicates far wider than the
 * `trust_safety:write`-gated detail page (CLAUDE.md §10 PII redaction).
 *
 * Instruments come from `getMeter`, which returns a usable no-op meter when
 * `initMetrics` was never called — safe to construct in unit tests without
 * booting the SDK. That same property is why this class could not honestly
 * ship before the bootstrap did (TS-306-followup-1a's finding): it would
 * have compiled, run, and reported nothing.
 */
@Injectable()
export class IncidentsMetrics {
  private readonly opened: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.opened = meter.createCounter('trust_safety_incidents_opened_total', {
      description:
        'Total trust & safety incidents opened, by source (family / senior / provider / concierge / system), severity and category.',
    });
  }

  /**
   * Record one opened incident. Called AFTER the insert transaction has
   * committed — a rolled-back intake must not appear in the count, for the
   * same reason it pages nobody (TS-306).
   */
  recordOpened(labels: {
    readonly source: IncidentSource;
    readonly severity: IncidentSeverity;
    readonly category: IncidentCategory;
  }): void {
    this.opened.add(1, {
      source: labels.source,
      severity: labels.severity,
      category: labels.category,
    });
  }
}
