import { describe, expect, it } from 'vitest';

import type { SearchRankingConfig } from '../http';
import {
  DeleteSearchRankingConfigResponseSchema,
  GetSearchRankingConfigResponseSchema,
  ListSearchRankingConfigResponseSchema,
  SEARCH_RANKING_DESCRIPTION_MAX_LENGTH,
  SEARCH_RANKING_REGION_CODE_GLOBAL,
  SEARCH_RANKING_REGION_CODE_MAX_LENGTH,
  SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_MAX,
  SEARCH_RANKING_TIER_WEIGHT_MIN,
  SearchRankingConfigRegionCodeSchema,
  SearchRankingConfigSchema,
  SearchRankingTierWeightSchema,
  UpsertSearchRankingConfigRequestSchema,
  UpsertSearchRankingConfigResponseSchema,
} from '../http';

const sampleConfig: SearchRankingConfig = {
  id: 'rc_abc',
  regionCode: SEARCH_RANKING_REGION_CODE_GLOBAL,
  description: 'Platform default — Elite ×1.5 / Certified ×1.2 / Basic ×1.0.',
  tierWeightBasic: SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT,
  tierWeightCertified: SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT,
  tierWeightElite: SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT,
  updatedByUserId: 'user_admin',
  createdAt: '2026-05-21T12:00:00.000Z',
  updatedAt: '2026-05-21T12:00:00.000Z',
};

describe('SearchRankingConfigRegionCodeSchema', () => {
  it('accepts canonical region slugs', () => {
    for (const slug of ['global', 'nyc', 'manhattan', 'bay_area', 'la-county', '02']) {
      expect(SearchRankingConfigRegionCodeSchema.safeParse(slug).success).toBe(true);
    }
  });

  it('rejects empty / over-long / mixed-case / invalid-first-char slugs', () => {
    for (const slug of [
      '',
      'NYC',
      '-leading',
      '_leading',
      'with space',
      'a'.repeat(SEARCH_RANKING_REGION_CODE_MAX_LENGTH + 1),
    ]) {
      expect(SearchRankingConfigRegionCodeSchema.safeParse(slug).success).toBe(false);
    }
  });
});

describe('SearchRankingTierWeightSchema', () => {
  it('accepts the canonical default weights', () => {
    for (const value of [
      SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT,
      SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT,
      SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT,
    ]) {
      expect(SearchRankingTierWeightSchema.safeParse(value).success).toBe(true);
    }
  });

  it('accepts the floor + ceiling', () => {
    expect(SearchRankingTierWeightSchema.safeParse(SEARCH_RANKING_TIER_WEIGHT_MIN).success).toBe(
      true,
    );
    expect(SearchRankingTierWeightSchema.safeParse(SEARCH_RANKING_TIER_WEIGHT_MAX).success).toBe(
      true,
    );
  });

  it('rejects zero / negative / NaN / Infinity / over-cap values', () => {
    for (const value of [
      0,
      -0.5,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      SEARCH_RANKING_TIER_WEIGHT_MAX + 0.01,
      SEARCH_RANKING_TIER_WEIGHT_MIN - 0.01,
    ]) {
      expect(SearchRankingTierWeightSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('SearchRankingConfigSchema', () => {
  it('accepts the canonical sample config', () => {
    expect(SearchRankingConfigSchema.safeParse(sampleConfig).success).toBe(true);
  });

  it('accepts a config with null description and null updatedByUserId', () => {
    expect(
      SearchRankingConfigSchema.safeParse({
        ...sampleConfig,
        description: null,
        updatedByUserId: null,
      }).success,
    ).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(
      SearchRankingConfigSchema.safeParse({
        ...sampleConfig,
        bogus: true,
      }).success,
    ).toBe(false);
  });

  it('rejects description longer than the cap', () => {
    expect(
      SearchRankingConfigSchema.safeParse({
        ...sampleConfig,
        description: 'd'.repeat(SEARCH_RANKING_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('rejects out-of-range tier weights', () => {
    expect(
      SearchRankingConfigSchema.safeParse({
        ...sampleConfig,
        tierWeightElite: SEARCH_RANKING_TIER_WEIGHT_MAX + 1,
      }).success,
    ).toBe(false);
  });
});

describe('UpsertSearchRankingConfigRequestSchema', () => {
  it('accepts a minimal body with only the three required weights', () => {
    expect(
      UpsertSearchRankingConfigRequestSchema.safeParse({
        tierWeightBasic: 1,
        tierWeightCertified: 1.2,
        tierWeightElite: 1.5,
      }).success,
    ).toBe(true);
  });

  it('accepts an optional description + updatedByUserId', () => {
    expect(
      UpsertSearchRankingConfigRequestSchema.safeParse({
        description: 'NYC override',
        tierWeightBasic: 1,
        tierWeightCertified: 1.3,
        tierWeightElite: 1.7,
        updatedByUserId: 'user_admin',
      }).success,
    ).toBe(true);
  });

  it('rejects missing weights', () => {
    expect(
      UpsertSearchRankingConfigRequestSchema.safeParse({
        tierWeightBasic: 1,
        tierWeightCertified: 1.2,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      UpsertSearchRankingConfigRequestSchema.safeParse({
        tierWeightBasic: 1,
        tierWeightCertified: 1.2,
        tierWeightElite: 1.5,
        bogus: true,
      }).success,
    ).toBe(false);
  });
});

describe('UpsertSearchRankingConfigResponseSchema', () => {
  it('accepts every outcome value paired with a config', () => {
    for (const outcome of ['created', 'updated', 'unchanged'] as const) {
      expect(
        UpsertSearchRankingConfigResponseSchema.safeParse({
          outcome,
          config: sampleConfig,
        }).success,
      ).toBe(true);
    }
  });

  it('rejects unknown outcomes', () => {
    expect(
      UpsertSearchRankingConfigResponseSchema.safeParse({
        outcome: 'deleted',
        config: sampleConfig,
      }).success,
    ).toBe(false);
  });
});

describe('ListSearchRankingConfigResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(ListSearchRankingConfigResponseSchema.safeParse({ configs: [] }).success).toBe(true);
  });

  it('accepts multiple configs', () => {
    expect(
      ListSearchRankingConfigResponseSchema.safeParse({
        configs: [sampleConfig, { ...sampleConfig, id: 'rc_2', regionCode: 'nyc' }],
      }).success,
    ).toBe(true);
  });
});

describe('GetSearchRankingConfigResponseSchema', () => {
  it('accepts the found kind', () => {
    expect(
      GetSearchRankingConfigResponseSchema.safeParse({
        kind: 'found',
        config: sampleConfig,
      }).success,
    ).toBe(true);
  });

  it('accepts the not_found kind', () => {
    expect(
      GetSearchRankingConfigResponseSchema.safeParse({
        kind: 'not_found',
        regionCode: 'manhattan',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown discriminant', () => {
    expect(
      GetSearchRankingConfigResponseSchema.safeParse({
        kind: 'pending',
        regionCode: 'manhattan',
      }).success,
    ).toBe(false);
  });
});

describe('DeleteSearchRankingConfigResponseSchema', () => {
  it('accepts both outcomes', () => {
    for (const outcome of ['deleted', 'not_found'] as const) {
      expect(
        DeleteSearchRankingConfigResponseSchema.safeParse({
          outcome,
          regionCode: 'nyc',
        }).success,
      ).toBe(true);
    }
  });

  it('rejects unknown outcomes', () => {
    expect(
      DeleteSearchRankingConfigResponseSchema.safeParse({
        outcome: 'created',
        regionCode: 'nyc',
      }).success,
    ).toBe(false);
  });
});

describe('TS-211 default weights', () => {
  it('matches the acceptance spec — Elite ×1.5 / Certified ×1.2 / Basic ×1.0', () => {
    expect(SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT).toBe(1.0);
    expect(SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT).toBe(1.2);
    expect(SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT).toBe(1.5);
  });

  it('canonical global region code is `global`', () => {
    expect(SEARCH_RANKING_REGION_CODE_GLOBAL).toBe('global');
  });
});
