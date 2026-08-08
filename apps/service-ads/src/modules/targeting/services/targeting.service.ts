import { Injectable, Logger } from '@nestjs/common';
import {
  AD_TARGETING_RULES_MAX,
  type AdTargetingAudience,
  type AdTargetingRule,
  type AdTargetingRuleKind,
} from '@taste-and-see/contracts';

import { AdTargetingRuleRepository } from '../repositories/ad-targeting-rule.repository';
import { TargetingMetrics } from './targeting-metrics';

/**
 * The outcome of evaluating a campaign's targeting against an audience.
 *
 *   - `match`              — whether the campaign is eligible to deliver to
 *                            this audience.
 *   - `ruleCount`          — well-formed rules that were AND-combined.
 *   - `malformedRuleCount` — rows that failed to decode (fail-closed: any
 *                            malformed rule forces `match = false`).
 */
export interface TargetingDecision {
  readonly match: boolean;
  readonly ruleCount: number;
  readonly malformedRuleCount: number;
}

/**
 * Server-side ad targeting evaluator (TS-273; PRD §10.9; PDD §18.1).
 *
 * Two surfaces:
 *
 *   1. `evaluateTargeting(audience, rules)` — the PURE engine. A campaign
 *      matches an audience IFF every rule matches (logical AND across rules);
 *      an empty rule set matches everyone. Per-rule semantics follow the
 *      grammar in `@taste-and-see/contracts` (`any_of` / `none_of` /
 *      `all_of`). No I/O — exhaustively unit-tested.
 *
 *   2. `evaluateCampaignTargeting(campaignId, audience)` — loads the
 *      campaign's persisted rule rows, decodes them, and runs the engine.
 *      The delivery path (TS-218 sponsored search slot / TS-275 capture)
 *      calls this per candidate campaign.
 *
 * Fail-closed posture (CLAUDE.md §16 — default to the safer option): a
 * campaign with any malformed rule, or with more rules than
 * `AD_TARGETING_RULES_MAX`, does NOT match. A corrupt or pathological
 * targeting expression can therefore never *widen* a campaign's reach.
 */
@Injectable()
export class TargetingService {
  private readonly logger = new Logger(TargetingService.name);

  constructor(
    private readonly rules: AdTargetingRuleRepository,
    private readonly metrics: TargetingMetrics,
  ) {}

  /**
   * Pure targeting engine: does `audience` satisfy ALL of `rules`?
   *
   * Empty `rules` → `true` (an untargeted campaign delivers to everyone).
   */
  evaluateTargeting(audience: AdTargetingAudience, rules: readonly AdTargetingRule[]): boolean {
    for (const rule of rules) {
      if (!this.evaluateRule(audience, rule)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Load + decode a campaign's rules and evaluate them against the audience.
   * Fails closed on malformed rules or a rule count over the defensive cap.
   */
  async evaluateCampaignTargeting(
    campaignId: string,
    audience: AdTargetingAudience,
  ): Promise<TargetingDecision> {
    const { rules, malformedCount } = await this.rules.loadCampaignRules(campaignId);
    const decision = this.decideTargeting(campaignId, audience, rules, malformedCount);
    this.metrics.recordEvaluation({
      match: decision.match,
      malformedRuleCount: decision.malformedRuleCount,
    });
    return decision;
  }

  /** The fail-closed decision logic, factored out so the I/O wrapper above can
   * record one metric per evaluation regardless of which branch decides it. */
  private decideTargeting(
    campaignId: string,
    audience: AdTargetingAudience,
    rules: readonly AdTargetingRule[],
    malformedCount: number,
  ): TargetingDecision {
    if (rules.length > AD_TARGETING_RULES_MAX) {
      this.logger.warn(
        `campaign targeting exceeds rule cap campaignId=${campaignId} ` +
          `ruleCount=${rules.length} cap=${AD_TARGETING_RULES_MAX} — failing closed`,
      );
      return { match: false, ruleCount: rules.length, malformedRuleCount: malformedCount };
    }

    if (malformedCount > 0) {
      // A rule we could not decode is a rule we cannot honour — exclude the
      // campaign rather than deliver against an unknown intent.
      return { match: false, ruleCount: rules.length, malformedRuleCount: malformedCount };
    }

    return {
      match: this.evaluateTargeting(audience, rules),
      ruleCount: rules.length,
      malformedRuleCount: 0,
    };
  }

  /**
   * Evaluate a single rule against the audience. Resolves the audience's
   * value(s) for the rule's dimension, then applies the set operator.
   */
  private evaluateRule(audience: AdTargetingAudience, rule: AdTargetingRule): boolean {
    const audienceValues = this.audienceValuesForKind(audience, rule.kind);
    const ruleValues = new Set(rule.predicate.values);

    switch (rule.predicate.operator) {
      case 'any_of':
        // Inclusion: the audience overlaps the targeted set.
        return audienceValues.some((value) => ruleValues.has(value));
      case 'none_of':
        // Exclusion: the audience does not overlap the targeted set. An
        // audience with no value for the dimension trivially passes.
        return audienceValues.every((value) => !ruleValues.has(value));
      case 'all_of': {
        // Subset: every targeted value is present in the audience set.
        const audienceSet = new Set(audienceValues);
        return rule.predicate.values.every((value) => audienceSet.has(value));
      }
    }
  }

  /**
   * The audience's value(s) for a targeting dimension. Single-valued
   * dimensions yield `[value]` (or `[]` when unknown); `behavior_cohort`
   * yields the audience's cohort set.
   */
  private audienceValuesForKind(
    audience: AdTargetingAudience,
    kind: AdTargetingRuleKind,
  ): readonly string[] {
    switch (kind) {
      case 'geography':
        return audience.geography != null ? [audience.geography] : [];
      case 'persona':
        return audience.persona != null ? [audience.persona] : [];
      case 'tier':
        return audience.tier != null ? [audience.tier] : [];
      case 'behavior_cohort':
        return audience.behaviorCohorts ?? [];
      case 'household_composition':
        return audience.householdComposition != null ? [audience.householdComposition] : [];
    }
  }
}
