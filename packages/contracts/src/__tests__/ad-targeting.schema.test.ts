import { describe, expect, it } from 'vitest';

import {
  AD_TARGETING_AUDIENCE_COHORTS_MAX,
  AD_TARGETING_PREDICATE_VALUES_MAX,
  AD_TARGETING_VALUE_MAX_LENGTH,
  AdTargetingAudienceSchema,
  AdTargetingMatchOperatorSchema,
  AdTargetingPredicateSchema,
  AdTargetingRuleKindSchema,
  AdTargetingRuleSchema,
  AdTargetingValueSchema,
  parseAdTargetingPredicate,
} from '../http/ad-targeting.schema';

describe('AdTargetingRuleKindSchema', () => {
  it('accepts every Prisma-mirrored dimension', () => {
    for (const kind of [
      'geography',
      'persona',
      'tier',
      'behavior_cohort',
      'household_composition',
    ]) {
      expect(AdTargetingRuleKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('rejects an unknown dimension', () => {
    expect(AdTargetingRuleKindSchema.safeParse('age').success).toBe(false);
  });
});

describe('AdTargetingMatchOperatorSchema', () => {
  it('accepts the three set operators', () => {
    for (const op of ['any_of', 'none_of', 'all_of']) {
      expect(AdTargetingMatchOperatorSchema.parse(op)).toBe(op);
    }
  });

  it('rejects an unknown operator', () => {
    expect(AdTargetingMatchOperatorSchema.safeParse('not_in').success).toBe(false);
  });
});

describe('AdTargetingValueSchema', () => {
  it('accepts slug/code tokens', () => {
    for (const v of ['NY-Manhattan', 'adult_child', 'tier_3_concierge', 'a.b:c', 'X']) {
      expect(AdTargetingValueSchema.parse(v)).toBe(v);
    }
  });

  it('rejects empty, whitespace, control, and over-long tokens', () => {
    expect(AdTargetingValueSchema.safeParse('').success).toBe(false);
    expect(AdTargetingValueSchema.safeParse('has space').success).toBe(false);
    expect(AdTargetingValueSchema.safeParse('tab\there').success).toBe(false);
    expect(
      AdTargetingValueSchema.safeParse('a'.repeat(AD_TARGETING_VALUE_MAX_LENGTH + 1)).success,
    ).toBe(false);
  });
});

describe('AdTargetingPredicateSchema', () => {
  it('accepts a well-formed predicate', () => {
    const predicate = { operator: 'any_of', values: ['NY-Manhattan', 'NY-Brooklyn'] };
    expect(AdTargetingPredicateSchema.parse(predicate)).toEqual(predicate);
  });

  it('rejects an empty values list', () => {
    expect(AdTargetingPredicateSchema.safeParse({ operator: 'any_of', values: [] }).success).toBe(
      false,
    );
  });

  it('rejects a values list over the cap', () => {
    const values = Array.from({ length: AD_TARGETING_PREDICATE_VALUES_MAX + 1 }, (_, i) => `c${i}`);
    expect(AdTargetingPredicateSchema.safeParse({ operator: 'any_of', values }).success).toBe(
      false,
    );
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      AdTargetingPredicateSchema.safeParse({
        operator: 'any_of',
        values: ['a'],
        weight: 2,
      }).success,
    ).toBe(false);
  });
});

describe('AdTargetingRuleSchema', () => {
  it('joins a kind with its predicate', () => {
    const rule = {
      kind: 'behavior_cohort',
      predicate: { operator: 'all_of', values: ['booked_last_30d', 'tier_2'] },
    };
    expect(AdTargetingRuleSchema.parse(rule)).toEqual(rule);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      AdTargetingRuleSchema.safeParse({
        kind: 'geography',
        predicate: { operator: 'any_of', values: ['NY'] },
        campaignId: 'abc',
      }).success,
    ).toBe(false);
  });
});

describe('AdTargetingAudienceSchema', () => {
  it('defaults behaviorCohorts to the empty set and treats omitted dimensions as null', () => {
    const audience = AdTargetingAudienceSchema.parse({});
    expect(audience.behaviorCohorts).toEqual([]);
    expect(audience.geography ?? null).toBeNull();
    expect(audience.persona ?? null).toBeNull();
    expect(audience.tier ?? null).toBeNull();
    expect(audience.householdComposition ?? null).toBeNull();
  });

  it('accepts a fully-populated audience', () => {
    const audience = AdTargetingAudienceSchema.parse({
      geography: 'NY-Manhattan',
      persona: 'adult_child',
      tier: 'tier_3_concierge',
      behaviorCohorts: ['booked_last_30d', 'high_value'],
      householdComposition: 'lives_alone',
    });
    expect(audience.geography).toBe('NY-Manhattan');
    expect(audience.behaviorCohorts).toEqual(['booked_last_30d', 'high_value']);
  });

  it('accepts explicit null for single-valued dimensions', () => {
    const audience = AdTargetingAudienceSchema.parse({ geography: null, tier: null });
    expect(audience.geography).toBeNull();
    expect(audience.tier).toBeNull();
  });

  it('rejects a cohort set over the cap', () => {
    const behaviorCohorts = Array.from(
      { length: AD_TARGETING_AUDIENCE_COHORTS_MAX + 1 },
      (_, i) => `c${i}`,
    );
    expect(AdTargetingAudienceSchema.safeParse({ behaviorCohorts }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(AdTargetingAudienceSchema.safeParse({ age: 70 }).success).toBe(false);
  });
});

describe('parseAdTargetingPredicate', () => {
  it('decodes a valid JSON AST', () => {
    const result = parseAdTargetingPredicate(
      JSON.stringify({ operator: 'any_of', values: ['NY'] }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.predicate.operator).toBe('any_of');
      expect(result.predicate.values).toEqual(['NY']);
    }
  });

  it('fails closed with invalid_json on non-JSON TEXT', () => {
    const result = parseAdTargetingPredicate('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_json');
    }
  });

  it('fails closed with invalid_shape on a valid-JSON-but-wrong-shape AST', () => {
    const result = parseAdTargetingPredicate(JSON.stringify({ operator: 'nope', values: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_shape');
    }
  });

  it('fails closed with invalid_shape on a non-object JSON value', () => {
    const result = parseAdTargetingPredicate('42');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_shape');
    }
  });
});
