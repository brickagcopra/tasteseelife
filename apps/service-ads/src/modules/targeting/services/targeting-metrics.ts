import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

const METER_NAME = 'service-ads:targeting';

/**
 * service-ads targeting-engine Prometheus instruments (TS-273-followup-1;
 * CLAUDE.md §10; PDD §20.5).
 *
 * Two counters span the load-then-evaluate delivery path
 * (`TargetingService.evaluateCampaignTargeting`):
 *
 *   - `ads_targeting_evaluations_total{match}` — every campaign-targeting
 *     evaluation, partitioned by whether the campaign matched the audience
 *     (`match="true"` / `match="false"`). A collapsing match rate is the
 *     leading indicator of an over-narrow targeting expression (or a
 *     mismatched audience-resolution upstream); a match rate of ~1 means
 *     campaigns are effectively untargeted.
 *   - `ads_targeting_rules_malformed_total` — rule rows that failed to decode
 *     during an evaluation (incremented by the malformed count, not once per
 *     evaluation). A non-zero value is a data-integrity alarm: a corrupt
 *     `ad_targeting_rules.value` AST forces the campaign to fail closed
 *     (`TargetingService` never widens reach on a malformed rule), so a
 *     rising count silently shrinks eligible inventory.
 *
 * Label cardinality is bounded by construction — `match` is a boolean string
 * and `ads_targeting_rules_malformed_total` is unlabelled. Campaign ids and
 * audience values stay on structured logs, never on metric labels (CLAUDE.md
 * §10 PII discipline). Instruments are created via `getMeter`, which returns a
 * usable no-op meter when `initMetrics` was never called — so this class is
 * safe to construct in unit tests without booting the SDK. Mirrors the
 * `SearchMetrics` / `WebhookMetrics` domain-instrument shape.
 */
@Injectable()
export class TargetingMetrics {
  private readonly evaluations: Counter;
  private readonly malformedRules: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.evaluations = meter.createCounter('ads_targeting_evaluations_total', {
      description: 'Total campaign-targeting evaluations, by match outcome',
    });
    this.malformedRules = meter.createCounter('ads_targeting_rules_malformed_total', {
      description: 'Total targeting-rule rows that failed to decode during evaluation',
    });
  }

  /**
   * Record one campaign-targeting evaluation: its match outcome plus any
   * malformed rule rows encountered (the malformed counter is left untouched
   * when there were none, so the series stays at zero rather than emitting a
   * `0`-increment on every clean evaluation).
   */
  recordEvaluation(input: { readonly match: boolean; readonly malformedRuleCount: number }): void {
    this.evaluations.add(1, { match: String(input.match) });
    if (input.malformedRuleCount > 0) {
      this.malformedRules.add(input.malformedRuleCount);
    }
  }
}
