import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AD_TARGETING_RULES_MAX,
  type AdTargetingAudience,
  type AdTargetingRule,
} from '@taste-and-see/contracts';

import type {
  AdTargetingRuleRepository,
  LoadedCampaignRules,
} from '../repositories/ad-targeting-rule.repository';
import { TargetingMetrics } from './targeting-metrics';
import { TargetingService } from './targeting.service';

/**
 * TargetingService unit suite (TS-273; PRD §10.9; PDD §18.1).
 *
 * Split in two:
 *   - the PURE `evaluateTargeting` engine — every dimension × operator ×
 *     edge case (unknown-audience-value, multi-rule AND, same-kind rules);
 *   - `evaluateCampaignTargeting` — the load-then-evaluate composition,
 *     driven by a fake repository so the fail-closed paths (malformed rule,
 *     over-cap rule count) are deterministic.
 */

/** Convenience audience builder — fills the cohort default the schema would. */
function audience(partial: Partial<AdTargetingAudience>): AdTargetingAudience {
  return {
    geography: null,
    persona: null,
    tier: null,
    behaviorCohorts: [],
    householdComposition: null,
    ...partial,
  };
}

function fakeRepository(loaded: LoadedCampaignRules): AdTargetingRuleRepository {
  return {
    loadCampaignRules: vi.fn(async (): Promise<LoadedCampaignRules> => loaded),
  } as unknown as AdTargetingRuleRepository;
}

describe('TargetingService.evaluateTargeting (pure engine)', () => {
  let service: TargetingService;

  beforeEach(() => {
    // The repo is unused by the pure path; pass an empty load.
    service = new TargetingService(
      fakeRepository({ rules: [], malformedCount: 0 }),
      new TargetingMetrics(),
    );
  });

  it('an empty rule set matches every audience', () => {
    expect(service.evaluateTargeting(audience({ geography: 'NY' }), [])).toBe(true);
    expect(service.evaluateTargeting(audience({}), [])).toBe(true);
  });

  describe('geography (single-valued dimension)', () => {
    const anyOf: AdTargetingRule = {
      kind: 'geography',
      predicate: { operator: 'any_of', values: ['NY-Manhattan', 'NY-Brooklyn'] },
    };
    const noneOf: AdTargetingRule = {
      kind: 'geography',
      predicate: { operator: 'none_of', values: ['NY-Manhattan'] },
    };

    it('any_of matches when the audience value is in the set', () => {
      expect(service.evaluateTargeting(audience({ geography: 'NY-Manhattan' }), [anyOf])).toBe(
        true,
      );
    });

    it('any_of fails when the audience value is outside the set', () => {
      expect(service.evaluateTargeting(audience({ geography: 'NY-Queens' }), [anyOf])).toBe(false);
    });

    it('any_of fails when the audience value is unknown (null)', () => {
      expect(service.evaluateTargeting(audience({ geography: null }), [anyOf])).toBe(false);
    });

    it('none_of fails when the audience value is in the excluded set', () => {
      expect(service.evaluateTargeting(audience({ geography: 'NY-Manhattan' }), [noneOf])).toBe(
        false,
      );
    });

    it('none_of matches when the audience value is outside the excluded set', () => {
      expect(service.evaluateTargeting(audience({ geography: 'NY-Queens' }), [noneOf])).toBe(true);
    });

    it('none_of matches when the audience value is unknown (not excluded)', () => {
      expect(service.evaluateTargeting(audience({ geography: null }), [noneOf])).toBe(true);
    });

    it('all_of with a single value behaves like any_of for a single-valued dimension', () => {
      const allOfOne: AdTargetingRule = {
        kind: 'geography',
        predicate: { operator: 'all_of', values: ['NY-Manhattan'] },
      };
      expect(service.evaluateTargeting(audience({ geography: 'NY-Manhattan' }), [allOfOne])).toBe(
        true,
      );
      expect(service.evaluateTargeting(audience({ geography: 'NY-Brooklyn' }), [allOfOne])).toBe(
        false,
      );
    });

    it('all_of with multiple values can never match a single-valued dimension', () => {
      const allOfTwo: AdTargetingRule = {
        kind: 'geography',
        predicate: { operator: 'all_of', values: ['NY-Manhattan', 'NY-Brooklyn'] },
      };
      expect(service.evaluateTargeting(audience({ geography: 'NY-Manhattan' }), [allOfTwo])).toBe(
        false,
      );
    });
  });

  describe('persona / tier / household_composition (other single-valued dimensions)', () => {
    it('persona any_of', () => {
      const rule: AdTargetingRule = {
        kind: 'persona',
        predicate: { operator: 'any_of', values: ['adult_child'] },
      };
      expect(service.evaluateTargeting(audience({ persona: 'adult_child' }), [rule])).toBe(true);
      expect(service.evaluateTargeting(audience({ persona: 'aging_parent' }), [rule])).toBe(false);
    });

    it('tier any_of', () => {
      const rule: AdTargetingRule = {
        kind: 'tier',
        predicate: { operator: 'any_of', values: ['tier_3_concierge'] },
      };
      expect(service.evaluateTargeting(audience({ tier: 'tier_3_concierge' }), [rule])).toBe(true);
      expect(service.evaluateTargeting(audience({ tier: 'tier_1_essential' }), [rule])).toBe(false);
    });

    it('household_composition any_of', () => {
      const rule: AdTargetingRule = {
        kind: 'household_composition',
        predicate: { operator: 'any_of', values: ['lives_alone'] },
      };
      expect(
        service.evaluateTargeting(audience({ householdComposition: 'lives_alone' }), [rule]),
      ).toBe(true);
      expect(
        service.evaluateTargeting(audience({ householdComposition: 'with_spouse' }), [rule]),
      ).toBe(false);
    });
  });

  describe('behavior_cohort (multi-valued dimension)', () => {
    it('any_of matches on intersection', () => {
      const rule: AdTargetingRule = {
        kind: 'behavior_cohort',
        predicate: { operator: 'any_of', values: ['booked_last_30d', 'high_value'] },
      };
      expect(
        service.evaluateTargeting(audience({ behaviorCohorts: ['high_value', 'newsletter'] }), [
          rule,
        ]),
      ).toBe(true);
      expect(service.evaluateTargeting(audience({ behaviorCohorts: ['newsletter'] }), [rule])).toBe(
        false,
      );
      expect(service.evaluateTargeting(audience({ behaviorCohorts: [] }), [rule])).toBe(false);
    });

    it('all_of requires every targeted cohort to be present', () => {
      const rule: AdTargetingRule = {
        kind: 'behavior_cohort',
        predicate: { operator: 'all_of', values: ['booked_last_30d', 'high_value'] },
      };
      expect(
        service.evaluateTargeting(
          audience({ behaviorCohorts: ['booked_last_30d', 'high_value', 'newsletter'] }),
          [rule],
        ),
      ).toBe(true);
      expect(
        service.evaluateTargeting(audience({ behaviorCohorts: ['booked_last_30d'] }), [rule]),
      ).toBe(false);
    });

    it('none_of matches when there is no overlap and excludes on overlap', () => {
      const rule: AdTargetingRule = {
        kind: 'behavior_cohort',
        predicate: { operator: 'none_of', values: ['churned'] },
      };
      expect(service.evaluateTargeting(audience({ behaviorCohorts: ['high_value'] }), [rule])).toBe(
        true,
      );
      expect(service.evaluateTargeting(audience({ behaviorCohorts: [] }), [rule])).toBe(true);
      expect(
        service.evaluateTargeting(audience({ behaviorCohorts: ['churned', 'high_value'] }), [rule]),
      ).toBe(false);
    });
  });

  describe('multiple rules (logical AND)', () => {
    const geoRule: AdTargetingRule = {
      kind: 'geography',
      predicate: { operator: 'any_of', values: ['NY-Manhattan'] },
    };
    const tierRule: AdTargetingRule = {
      kind: 'tier',
      predicate: { operator: 'any_of', values: ['tier_3_concierge'] },
    };

    it('matches only when every rule passes', () => {
      expect(
        service.evaluateTargeting(
          audience({ geography: 'NY-Manhattan', tier: 'tier_3_concierge' }),
          [geoRule, tierRule],
        ),
      ).toBe(true);
    });

    it('fails when any single rule fails', () => {
      expect(
        service.evaluateTargeting(
          audience({ geography: 'NY-Manhattan', tier: 'tier_1_essential' }),
          [geoRule, tierRule],
        ),
      ).toBe(false);
    });

    it('AND-combines two rules of the same dimension (include then exclude)', () => {
      const includeAB: AdTargetingRule = {
        kind: 'geography',
        predicate: { operator: 'any_of', values: ['NY-Manhattan', 'NY-Brooklyn'] },
      };
      const excludeB: AdTargetingRule = {
        kind: 'geography',
        predicate: { operator: 'none_of', values: ['NY-Brooklyn'] },
      };
      expect(
        service.evaluateTargeting(audience({ geography: 'NY-Manhattan' }), [includeAB, excludeB]),
      ).toBe(true);
      expect(
        service.evaluateTargeting(audience({ geography: 'NY-Brooklyn' }), [includeAB, excludeB]),
      ).toBe(false);
    });
  });
});

describe('TargetingService.evaluateCampaignTargeting (load + evaluate)', () => {
  const matchingAudience = audience({ geography: 'NY-Manhattan' });
  const geoRule: AdTargetingRule = {
    kind: 'geography',
    predicate: { operator: 'any_of', values: ['NY-Manhattan'] },
  };

  it('evaluates well-formed rules against the audience', async () => {
    const service = new TargetingService(
      fakeRepository({ rules: [geoRule], malformedCount: 0 }),
      new TargetingMetrics(),
    );
    const decision = await service.evaluateCampaignTargeting('cmp_1', matchingAudience);
    expect(decision).toEqual({ match: true, ruleCount: 1, malformedRuleCount: 0 });
  });

  it('matches a campaign with no rules', async () => {
    const service = new TargetingService(
      fakeRepository({ rules: [], malformedCount: 0 }),
      new TargetingMetrics(),
    );
    const decision = await service.evaluateCampaignTargeting('cmp_2', matchingAudience);
    expect(decision).toEqual({ match: true, ruleCount: 0, malformedRuleCount: 0 });
  });

  it('fails closed when any rule is malformed, even if the parseable rules would match', async () => {
    const service = new TargetingService(
      fakeRepository({ rules: [geoRule], malformedCount: 1 }),
      new TargetingMetrics(),
    );
    const decision = await service.evaluateCampaignTargeting('cmp_3', matchingAudience);
    expect(decision).toEqual({ match: false, ruleCount: 1, malformedRuleCount: 1 });
  });

  it('fails closed when the rule count exceeds the defensive cap', async () => {
    const rules: AdTargetingRule[] = Array.from(
      { length: AD_TARGETING_RULES_MAX + 1 },
      () => geoRule,
    );
    const service = new TargetingService(
      fakeRepository({ rules, malformedCount: 0 }),
      new TargetingMetrics(),
    );
    const decision = await service.evaluateCampaignTargeting('cmp_4', matchingAudience);
    expect(decision.match).toBe(false);
    expect(decision.ruleCount).toBe(AD_TARGETING_RULES_MAX + 1);
  });

  it('returns a non-match when a well-formed rule excludes the audience', async () => {
    const service = new TargetingService(
      fakeRepository({ rules: [geoRule], malformedCount: 0 }),
      new TargetingMetrics(),
    );
    const decision = await service.evaluateCampaignTargeting(
      'cmp_5',
      audience({ geography: 'NY-Queens' }),
    );
    expect(decision).toEqual({ match: false, ruleCount: 1, malformedRuleCount: 0 });
  });
});
