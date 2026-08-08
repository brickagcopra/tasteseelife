import { describe, expect, it } from 'vitest';

import {
  RECOMMENDATION_LIMIT_DEFAULT,
  RECOMMENDATION_LIMIT_MAX,
  RECOMMENDATION_PROFILE_TAGS_MAX,
  RECOMMENDATION_SIGNAL_MATCHED_VALUES_MAX,
  RECOMMENDATION_SIGNALS_MAX,
  RecommendProvidersRequestSchema,
  RecommendProvidersResponseSchema,
  RecommendationSeniorProfileSchema,
  RecommendationSignalKindSchema,
  RecommendationSignalSchema,
  RecommendedProviderSchema,
  SeniorRecommendedProvidersResponseSchema,
} from '../http/provider-recommendation.schema';

const T0 = '2026-06-01T09:00:00.000Z';

function buildProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    languages: ['en', 'es'],
    dietaryTags: ['kosher', 'low_sodium'],
    cuisinePreferences: ['italian', 'jewish'],
    dementiaSensitive: false,
    ...overrides,
  };
}

function buildDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'prov_abc',
    userId: 'user_abc',
    displayName: 'Chef Rosa',
    headline: 'Warm Italian home cooking',
    bio: null,
    tier: 'certified',
    status: 'active',
    languages: ['en', 'es'],
    specialties: ['comfort_food'],
    cuisines: ['italian'],
    dietaryExpertise: ['kosher'],
    certifications: [],
    centroid: null,
    ratingAverage: 4.8,
    ratingCount: 12,
    completedBookingCount: 30,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    availabilitySummary: null,
    sourceUpdatedAt: T0,
    ...overrides,
  };
}

function buildSignal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'language',
    matchedValues: ['es'],
    contribution: 3,
    ...overrides,
  };
}

function buildRecommendation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    document: buildDocument(),
    score: 7.5,
    signals: [buildSignal(), { kind: 'rating', matchedValues: [], contribution: 0.96 }],
    ...overrides,
  };
}

describe('RecommendationSeniorProfileSchema', () => {
  it('parses a full profile', () => {
    const parsed = RecommendationSeniorProfileSchema.parse(buildProfile());
    expect(parsed.languages).toEqual(['en', 'es']);
    expect(parsed.dementiaSensitive).toBe(false);
  });

  it('accepts empty signal arrays (a senior with no captured signals)', () => {
    const parsed = RecommendationSeniorProfileSchema.parse(
      buildProfile({ languages: [], dietaryTags: [], cuisinePreferences: [] }),
    );
    expect(parsed.languages).toEqual([]);
  });

  it('rejects an unknown field', () => {
    expect(() =>
      RecommendationSeniorProfileSchema.parse(buildProfile({ seniorId: 'snr_1' })),
    ).toThrow();
  });

  it('rejects a tag with invalid characters', () => {
    expect(() =>
      RecommendationSeniorProfileSchema.parse(buildProfile({ languages: ['EN US'] })),
    ).toThrow();
  });

  it('rejects more than the per-facet tag cap', () => {
    const tooMany = Array.from({ length: RECOMMENDATION_PROFILE_TAGS_MAX + 1 }, (_, i) => `c${i}`);
    expect(() =>
      RecommendationSeniorProfileSchema.parse(buildProfile({ cuisinePreferences: tooMany })),
    ).toThrow();
  });

  it('requires dementiaSensitive to be a boolean', () => {
    expect(() =>
      RecommendationSeniorProfileSchema.parse(buildProfile({ dementiaSensitive: 'yes' })),
    ).toThrow();
  });
});

describe('RecommendProvidersRequestSchema', () => {
  it('defaults limit when omitted', () => {
    const parsed = RecommendProvidersRequestSchema.parse({ profile: buildProfile() });
    expect(parsed.limit).toBe(RECOMMENDATION_LIMIT_DEFAULT);
  });

  it('accepts an explicit limit within bounds', () => {
    const parsed = RecommendProvidersRequestSchema.parse({ profile: buildProfile(), limit: 5 });
    expect(parsed.limit).toBe(5);
  });

  it('rejects a limit above the ceiling', () => {
    expect(() =>
      RecommendProvidersRequestSchema.parse({
        profile: buildProfile(),
        limit: RECOMMENDATION_LIMIT_MAX + 1,
      }),
    ).toThrow();
  });

  it('rejects a non-positive limit', () => {
    expect(() =>
      RecommendProvidersRequestSchema.parse({ profile: buildProfile(), limit: 0 }),
    ).toThrow();
  });

  it('rejects a missing profile', () => {
    expect(() => RecommendProvidersRequestSchema.parse({ limit: 10 })).toThrow();
  });
});

describe('RecommendationSignalKindSchema', () => {
  it.each([
    'language',
    'dietary',
    'cuisine',
    'dementia_experience',
    'rating',
    'popularity',
    'tier',
  ])('accepts the %s signal kind', (kind) => {
    expect(RecommendationSignalKindSchema.parse(kind)).toBe(kind);
  });

  it('rejects an unknown kind', () => {
    expect(() => RecommendationSignalKindSchema.parse('vibes')).toThrow();
  });
});

describe('RecommendationSignalSchema', () => {
  it('parses a match signal with matched values', () => {
    const parsed = RecommendationSignalSchema.parse(buildSignal());
    expect(parsed.matchedValues).toEqual(['es']);
    expect(parsed.contribution).toBe(3);
  });

  it('parses a quality signal with empty matched values', () => {
    const parsed = RecommendationSignalSchema.parse({
      kind: 'tier',
      matchedValues: [],
      contribution: 1.2,
    });
    expect(parsed.matchedValues).toEqual([]);
  });

  it('rejects a negative contribution', () => {
    expect(() => RecommendationSignalSchema.parse(buildSignal({ contribution: -1 }))).toThrow();
  });

  it('rejects more matched values than the cap', () => {
    const tooMany = Array.from(
      { length: RECOMMENDATION_SIGNAL_MATCHED_VALUES_MAX + 1 },
      (_, i) => `v${i}`,
    );
    expect(() =>
      RecommendationSignalSchema.parse(buildSignal({ matchedValues: tooMany })),
    ).toThrow();
  });
});

describe('RecommendedProviderSchema', () => {
  it('parses a recommendation carrying the document + signals', () => {
    const parsed = RecommendedProviderSchema.parse(buildRecommendation());
    expect(parsed.document.providerId).toBe('prov_abc');
    expect(parsed.signals).toHaveLength(2);
  });

  it('rejects a negative score', () => {
    expect(() => RecommendedProviderSchema.parse(buildRecommendation({ score: -0.1 }))).toThrow();
  });

  it('rejects more signals than the cap', () => {
    const tooMany = Array.from({ length: RECOMMENDATION_SIGNALS_MAX + 1 }, () =>
      buildSignal({ kind: 'rating', matchedValues: [] }),
    );
    expect(() =>
      RecommendedProviderSchema.parse(buildRecommendation({ signals: tooMany })),
    ).toThrow();
  });
});

describe('RecommendProvidersResponseSchema', () => {
  it('parses a response with recommendations + liveMode', () => {
    const parsed = RecommendProvidersResponseSchema.parse({
      recommendations: [buildRecommendation()],
      liveMode: false,
    });
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed.liveMode).toBe(false);
  });

  it('parses an empty recommendations list', () => {
    const parsed = RecommendProvidersResponseSchema.parse({ recommendations: [], liveMode: true });
    expect(parsed.recommendations).toEqual([]);
  });

  it('rejects a missing liveMode', () => {
    expect(() => RecommendProvidersResponseSchema.parse({ recommendations: [] })).toThrow();
  });
});

describe('SeniorRecommendedProvidersResponseSchema', () => {
  it('parses the gateway response with seniorId + generatedAt', () => {
    const parsed = SeniorRecommendedProvidersResponseSchema.parse({
      seniorId: 'snr_abc',
      recommendations: [buildRecommendation()],
      generatedAt: T0,
    });
    expect(parsed.seniorId).toBe('snr_abc');
    expect(parsed.generatedAt).toBe(T0);
  });

  it('rejects a liveMode field (internal-only ops detail)', () => {
    expect(() =>
      SeniorRecommendedProvidersResponseSchema.parse({
        seniorId: 'snr_abc',
        recommendations: [],
        generatedAt: T0,
        liveMode: false,
      }),
    ).toThrow();
  });

  it('rejects a malformed generatedAt', () => {
    expect(() =>
      SeniorRecommendedProvidersResponseSchema.parse({
        seniorId: 'snr_abc',
        recommendations: [],
        generatedAt: 'yesterday',
      }),
    ).toThrow();
  });
});
