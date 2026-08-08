import { describe, expect, it } from 'vitest';

import {
  DeleteProviderDocumentResponseSchema,
  PROVIDER_DISCOVERY_BIO_MAX_LENGTH,
  PROVIDER_DISCOVERY_DISPLAY_NAME_MAX_LENGTH,
  PROVIDER_DISCOVERY_FILTER_VALUES_MAX,
  PROVIDER_DISCOVERY_LIMIT_DEFAULT,
  PROVIDER_DISCOVERY_LIMIT_MAX,
  PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX,
  PROVIDER_DISCOVERY_QUERY_MAX_LENGTH,
  PROVIDER_DISCOVERY_RADIUS_KM_DEFAULT,
  PROVIDER_DISCOVERY_RADIUS_KM_MAX,
  PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX,
  ProviderDiscoveryDocumentSchema,
  ProviderDiscoverySortSchema,
  ProviderDiscoveryStatusSchema,
  ProviderDiscoveryTierSchema,
  SearchProvidersRequestSchema,
  SearchProvidersResponseSchema,
  UpsertProviderDocumentRequestSchema,
  UpsertProviderDocumentResponseSchema,
} from '../http/provider-discovery.schema';

const ISO_NOW = '2026-05-16T12:00:00.000Z';

function buildDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'prov_abc',
    userId: 'user_abc',
    displayName: 'Chef Alice',
    headline: 'Italian comfort cuisine',
    bio: 'Twenty years of trattoria experience.',
    tier: 'certified',
    status: 'active',
    languages: ['en', 'it'],
    specialties: ['dementia_sensitive'],
    cuisines: ['italian'],
    dietaryExpertise: ['gluten_free'],
    certifications: ['ccc'],
    centroid: { latitude: 40.7813, longitude: -73.9656 },
    ratingAverage: 4.7,
    ratingCount: 41,
    completedBookingCount: 87,
    profilePhotoKey: 'dev/provider_profile_photo/2026/05/asset_abc',
    videoIntroKey: null,
    timeZone: 'America/New_York',
    availabilitySummary: null,
    sourceUpdatedAt: ISO_NOW,
    ...overrides,
  };
}

describe('ProviderDiscoveryTierSchema', () => {
  it.each(['basic', 'certified', 'elite'] as const)('accepts %s', (value) => {
    expect(ProviderDiscoveryTierSchema.parse(value)).toBe(value);
  });

  it('rejects unknown tier', () => {
    expect(() => ProviderDiscoveryTierSchema.parse('platinum')).toThrow();
  });
});

describe('ProviderDiscoveryStatusSchema', () => {
  it.each(['pending', 'in_review', 'active', 'suspended', 'archived'] as const)(
    'accepts %s',
    (value) => {
      expect(ProviderDiscoveryStatusSchema.parse(value)).toBe(value);
    },
  );

  it('rejects unknown status', () => {
    expect(() => ProviderDiscoveryStatusSchema.parse('banned')).toThrow();
  });
});

describe('ProviderDiscoverySortSchema', () => {
  it.each(['relevance', 'rating', 'distance'] as const)('accepts %s', (value) => {
    expect(ProviderDiscoverySortSchema.parse(value)).toBe(value);
  });

  it('rejects unknown sort', () => {
    expect(() => ProviderDiscoverySortSchema.parse('price')).toThrow();
  });
});

describe('ProviderDiscoveryDocumentSchema', () => {
  it('parses a complete document', () => {
    const parsed = ProviderDiscoveryDocumentSchema.parse(buildDocument());
    expect(parsed.providerId).toBe('prov_abc');
    expect(parsed.tier).toBe('certified');
    expect(parsed.centroid?.latitude).toBeCloseTo(40.7813);
    expect(parsed.ratingAverage).toBe(4.7);
  });

  it('accepts nullable headline / bio / centroid / rating / media keys', () => {
    const parsed = ProviderDiscoveryDocumentSchema.parse(
      buildDocument({
        headline: null,
        bio: null,
        centroid: null,
        ratingAverage: null,
        profilePhotoKey: null,
        videoIntroKey: null,
      }),
    );
    expect(parsed.headline).toBeNull();
    expect(parsed.bio).toBeNull();
    expect(parsed.centroid).toBeNull();
    expect(parsed.ratingAverage).toBeNull();
  });

  it('rejects unknown fields (strict mode)', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ extraField: 'oops' })),
    ).toThrow();
  });

  it('rejects out-of-range latitude', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(
        buildDocument({ centroid: { latitude: 91, longitude: 0 } }),
      ),
    ).toThrow();
  });

  it('rejects out-of-range longitude', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(
        buildDocument({ centroid: { latitude: 0, longitude: -181 } }),
      ),
    ).toThrow();
  });

  it('rejects rating > 5', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ ratingAverage: 5.1 })),
    ).toThrow();
  });

  it('rejects negative ratingCount', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ ratingCount: -1 })),
    ).toThrow();
  });

  it('rejects non-integer ratingCount', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ ratingCount: 1.5 })),
    ).toThrow();
  });

  it('rejects malformed tag (upper case)', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ languages: ['EN'] })),
    ).toThrow();
  });

  it('rejects malformed tag (whitespace)', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ specialties: ['dementia sensitive'] })),
    ).toThrow();
  });

  it('rejects over-cap tags per facet', () => {
    const tooMany = Array.from(
      { length: PROVIDER_DISCOVERY_TAGS_PER_FACET_MAX + 1 },
      (_, i) => `tag-${i}`,
    );
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ specialties: tooMany })),
    ).toThrow();
  });

  it('rejects over-length displayName', () => {
    const tooLong = 'x'.repeat(PROVIDER_DISCOVERY_DISPLAY_NAME_MAX_LENGTH + 1);
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ displayName: tooLong })),
    ).toThrow();
  });

  it('rejects over-length bio', () => {
    const tooLong = 'x'.repeat(PROVIDER_DISCOVERY_BIO_MAX_LENGTH + 1);
    expect(() => ProviderDiscoveryDocumentSchema.parse(buildDocument({ bio: tooLong }))).toThrow();
  });

  it('rejects malformed sourceUpdatedAt', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(buildDocument({ sourceUpdatedAt: 'not-a-date' })),
    ).toThrow();
  });

  it('accepts a non-null availabilitySummary projection (TS-203)', () => {
    const parsed = ProviderDiscoveryDocumentSchema.parse(
      buildDocument({
        availabilitySummary: {
          timeZone: 'America/New_York',
          entries: [
            {
              date: '2026-05-21',
              weekday: 'thursday',
              startTime: '09:00',
              endTime: '13:00',
            },
            {
              date: '2026-05-22',
              weekday: 'friday',
              startTime: '18:00',
              endTime: '21:00',
            },
          ],
          generatedAt: ISO_NOW,
        },
      }),
    );
    expect(parsed.availabilitySummary?.entries).toHaveLength(2);
    expect(parsed.availabilitySummary?.entries[0]?.startTime).toBe('09:00');
  });

  it('rejects an availabilitySummary entry with HH:MM out of range (TS-203)', () => {
    expect(() =>
      ProviderDiscoveryDocumentSchema.parse(
        buildDocument({
          availabilitySummary: {
            timeZone: 'America/New_York',
            entries: [
              {
                date: '2026-05-21',
                weekday: 'thursday',
                startTime: '24:00',
                endTime: '25:00',
              },
            ],
            generatedAt: ISO_NOW,
          },
        }),
      ),
    ).toThrow();
  });
});

describe('SearchProvidersRequestSchema', () => {
  it('parses an empty body and applies defaults', () => {
    const parsed = SearchProvidersRequestSchema.parse({});
    expect(parsed.sort).toBe('relevance');
    expect(parsed.limit).toBe(PROVIDER_DISCOVERY_LIMIT_DEFAULT);
    expect(parsed.query).toBeUndefined();
    expect(parsed.geo).toBeUndefined();
  });

  it('parses a full filter payload', () => {
    const parsed = SearchProvidersRequestSchema.parse({
      query: 'italian',
      filters: {
        tiers: ['certified', 'elite'],
        languages: ['en', 'it'],
        specialties: ['dementia_sensitive'],
        cuisines: ['italian'],
        dietaryExpertise: ['gluten_free'],
        certifications: ['ccc'],
        minRating: 4,
      },
      geo: { center: { latitude: 40.7813, longitude: -73.9656 }, radiusKm: 25 },
      sort: 'relevance',
      limit: 30,
    });
    expect(parsed.filters?.tiers).toEqual(['certified', 'elite']);
    expect(parsed.geo?.radiusKm).toBe(25);
  });

  it('applies the default geo radius when omitted', () => {
    const parsed = SearchProvidersRequestSchema.parse({
      geo: { center: { latitude: 1, longitude: 2 } },
    });
    expect(parsed.geo?.radiusKm).toBe(PROVIDER_DISCOVERY_RADIUS_KM_DEFAULT);
  });

  it('rejects radiusKm above the cap', () => {
    expect(() =>
      SearchProvidersRequestSchema.parse({
        geo: {
          center: { latitude: 1, longitude: 2 },
          radiusKm: PROVIDER_DISCOVERY_RADIUS_KM_MAX + 1,
        },
      }),
    ).toThrow();
  });

  it('rejects sort=distance without geo', () => {
    expect(() => SearchProvidersRequestSchema.parse({ sort: 'distance' })).toThrow(
      /distance sort requires a geo center/,
    );
  });

  it('accepts sort=distance with geo supplied', () => {
    const parsed = SearchProvidersRequestSchema.parse({
      sort: 'distance',
      geo: { center: { latitude: 0, longitude: 0 } },
    });
    expect(parsed.sort).toBe('distance');
  });

  it('rejects over-cap limit', () => {
    expect(() =>
      SearchProvidersRequestSchema.parse({ limit: PROVIDER_DISCOVERY_LIMIT_MAX + 1 }),
    ).toThrow();
  });

  it('rejects zero limit', () => {
    expect(() => SearchProvidersRequestSchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects unknown filter facet (strict)', () => {
    expect(() =>
      SearchProvidersRequestSchema.parse({ filters: { unknownFacet: ['a'] } }),
    ).toThrow();
  });

  it('rejects over-cap filter values', () => {
    const tooMany = Array.from(
      { length: PROVIDER_DISCOVERY_FILTER_VALUES_MAX + 1 },
      (_, i) => `lang-${i}`,
    );
    expect(() => SearchProvidersRequestSchema.parse({ filters: { languages: tooMany } })).toThrow();
  });

  it('rejects empty filter values array', () => {
    expect(() => SearchProvidersRequestSchema.parse({ filters: { languages: [] } })).toThrow();
  });

  it('rejects over-length query', () => {
    const tooLong = 'x'.repeat(PROVIDER_DISCOVERY_QUERY_MAX_LENGTH + 1);
    expect(() => SearchProvidersRequestSchema.parse({ query: tooLong })).toThrow();
  });

  it('rejects unknown top-level field (strict)', () => {
    expect(() => SearchProvidersRequestSchema.parse({ unknown: true })).toThrow();
  });

  it('rejects minRating > 5', () => {
    expect(() => SearchProvidersRequestSchema.parse({ filters: { minRating: 5.1 } })).toThrow();
  });

  it('rejects negative minRating', () => {
    expect(() => SearchProvidersRequestSchema.parse({ filters: { minRating: -0.1 } })).toThrow();
  });

  // TS-215-followup-2 — `providerIds` filter lets the family-portal
  // /favorites page hydrate up to 24 favourite rows with their
  // denormalised discovery docs in a single round-trip.
  it('accepts a providerIds filter at the cap', () => {
    const ids = Array.from(
      { length: PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX },
      (_, i) => `prov_${i}`,
    );
    const parsed = SearchProvidersRequestSchema.parse({ filters: { providerIds: ids } });
    expect(parsed.filters?.providerIds).toHaveLength(PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX);
  });

  it('rejects an empty providerIds array', () => {
    expect(() => SearchProvidersRequestSchema.parse({ filters: { providerIds: [] } })).toThrow();
  });

  it('rejects providerIds over the cap', () => {
    const tooMany = Array.from(
      { length: PROVIDER_DISCOVERY_PROVIDER_IDS_FILTER_MAX + 1 },
      (_, i) => `prov_${i}`,
    );
    expect(() =>
      SearchProvidersRequestSchema.parse({ filters: { providerIds: tooMany } }),
    ).toThrow();
  });

  it('rejects a providerIds entry that is empty / over-length', () => {
    expect(() => SearchProvidersRequestSchema.parse({ filters: { providerIds: [''] } })).toThrow();
    const overLong = 'x'.repeat(65);
    expect(() =>
      SearchProvidersRequestSchema.parse({ filters: { providerIds: [overLong] } }),
    ).toThrow();
  });
});

describe('SearchProvidersResponseSchema', () => {
  it('parses an empty result set', () => {
    const parsed = SearchProvidersResponseSchema.parse({
      hits: [],
      facets: {
        tiers: [],
        languages: [],
        specialties: [],
        cuisines: [],
        certifications: [],
      },
      totalEstimate: 0,
      nextCursor: null,
      liveMode: false,
      searchId: 'srch_abc123',
    });
    expect(parsed.hits).toEqual([]);
    expect(parsed.totalEstimate).toBe(0);
    expect(parsed.searchId).toBe('srch_abc123');
  });

  it('parses a populated page with a next cursor', () => {
    const parsed = SearchProvidersResponseSchema.parse({
      hits: [
        {
          document: buildDocument(),
          score: 1.42,
          distanceKm: 3.14,
          featured: false,
          sponsored: null,
        },
      ],
      facets: {
        tiers: [{ value: 'certified', count: 1 }],
        languages: [
          { value: 'en', count: 1 },
          { value: 'it', count: 1 },
        ],
        specialties: [{ value: 'dementia_sensitive', count: 1 }],
        cuisines: [{ value: 'italian', count: 1 }],
        certifications: [{ value: 'ccc', count: 1 }],
      },
      totalEstimate: 1,
      nextCursor: 'opaque-cursor-token',
      liveMode: false,
      searchId: 'srch_abc123',
    });
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0]?.featured).toBe(false);
    expect(parsed.hits[0]?.sponsored).toBeNull();
    expect(parsed.nextCursor).toBe('opaque-cursor-token');
  });

  it('parses a sponsored hit carrying its campaign + creative (TS-218b)', () => {
    const parsed = SearchProvidersResponseSchema.parse({
      hits: [
        {
          document: buildDocument(),
          score: 2.1,
          distanceKm: null,
          featured: true,
          sponsored: { campaignId: 'camp_abc', creativeId: 'crv_xyz' },
        },
      ],
      facets: {
        tiers: [],
        languages: [],
        specialties: [],
        cuisines: [],
        certifications: [],
      },
      totalEstimate: 1,
      nextCursor: null,
      liveMode: false,
      searchId: 'srch_abc123',
    });
    // A hit can be both sponsored AND featured — the two flags are independent.
    expect(parsed.hits[0]?.featured).toBe(true);
    expect(parsed.hits[0]?.sponsored).toEqual({ campaignId: 'camp_abc', creativeId: 'crv_xyz' });
  });

  it('rejects a hit missing the featured flag (TS-207)', () => {
    expect(() =>
      SearchProvidersResponseSchema.parse({
        hits: [{ document: buildDocument(), score: 1, distanceKm: null, sponsored: null }],
        facets: {
          tiers: [],
          languages: [],
          specialties: [],
          cuisines: [],
          certifications: [],
        },
        totalEstimate: 1,
        nextCursor: null,
        liveMode: false,
        searchId: 'srch_abc123',
      }),
    ).toThrow();
  });

  it('rejects a hit missing the sponsored discriminator (TS-218b)', () => {
    expect(() =>
      SearchProvidersResponseSchema.parse({
        hits: [{ document: buildDocument(), score: 1, distanceKm: null, featured: false }],
        facets: {
          tiers: [],
          languages: [],
          specialties: [],
          cuisines: [],
          certifications: [],
        },
        totalEstimate: 1,
        nextCursor: null,
        liveMode: false,
        searchId: 'srch_abc123',
      }),
    ).toThrow();
  });

  it('rejects a sponsored block carrying an unknown key (TS-218b strict)', () => {
    expect(() =>
      SearchProvidersResponseSchema.parse({
        hits: [
          {
            document: buildDocument(),
            score: 1,
            distanceKm: null,
            featured: false,
            sponsored: { campaignId: 'camp_abc', creativeId: 'crv_xyz', providerId: 'prov_x' },
          },
        ],
        facets: {
          tiers: [],
          languages: [],
          specialties: [],
          cuisines: [],
          certifications: [],
        },
        totalEstimate: 1,
        nextCursor: null,
        liveMode: false,
        searchId: 'srch_abc123',
      }),
    ).toThrow();
  });

  it('rejects a negative score', () => {
    expect(() =>
      SearchProvidersResponseSchema.parse({
        hits: [
          {
            document: buildDocument(),
            score: -0.1,
            distanceKm: null,
            featured: false,
            sponsored: null,
          },
        ],
        facets: {
          tiers: [],
          languages: [],
          specialties: [],
          cuisines: [],
          certifications: [],
        },
        totalEstimate: 0,
        nextCursor: null,
        liveMode: false,
        searchId: 'srch_abc123',
      }),
    ).toThrow();
  });

  it('rejects negative totalEstimate', () => {
    expect(() =>
      SearchProvidersResponseSchema.parse({
        hits: [],
        facets: {
          tiers: [],
          languages: [],
          specialties: [],
          cuisines: [],
          certifications: [],
        },
        totalEstimate: -1,
        nextCursor: null,
        liveMode: false,
        searchId: 'srch_abc123',
      }),
    ).toThrow();
  });

  it('rejects unknown facet (strict)', () => {
    expect(() =>
      SearchProvidersResponseSchema.parse({
        hits: [],
        facets: {
          tiers: [],
          languages: [],
          specialties: [],
          cuisines: [],
          certifications: [],
          unknown: [],
        },
        totalEstimate: 0,
        nextCursor: null,
        liveMode: false,
        searchId: 'srch_abc123',
      }),
    ).toThrow();
  });

  // TS-217-prep-4a — the search-correlation id the family-portal echoes on
  // search.result_clicked / booking.created. Required + non-empty + bounded.
  const baseResponse = {
    hits: [],
    facets: {
      tiers: [],
      languages: [],
      specialties: [],
      cuisines: [],
      certifications: [],
    },
    totalEstimate: 0,
    nextCursor: null,
    liveMode: false,
  } as const;

  it('rejects a response missing searchId (TS-217-prep-4a)', () => {
    expect(() => SearchProvidersResponseSchema.parse({ ...baseResponse })).toThrow();
  });

  it('rejects an empty searchId', () => {
    expect(() => SearchProvidersResponseSchema.parse({ ...baseResponse, searchId: '' })).toThrow();
  });

  it('rejects a searchId over 128 chars', () => {
    expect(() =>
      SearchProvidersResponseSchema.parse({ ...baseResponse, searchId: 'a'.repeat(129) }),
    ).toThrow();
  });

  it('accepts a UUID-shaped searchId', () => {
    const parsed = SearchProvidersResponseSchema.parse({
      ...baseResponse,
      searchId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
    expect(parsed.searchId).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });
});

describe('UpsertProviderDocumentRequestSchema', () => {
  it('parses a valid upsert body', () => {
    const parsed = UpsertProviderDocumentRequestSchema.parse({ document: buildDocument() });
    expect(parsed.document.providerId).toBe('prov_abc');
  });

  it('rejects unknown top-level field (strict)', () => {
    expect(() =>
      UpsertProviderDocumentRequestSchema.parse({ document: buildDocument(), extra: 1 }),
    ).toThrow();
  });

  it('rejects body without document', () => {
    expect(() => UpsertProviderDocumentRequestSchema.parse({})).toThrow();
  });
});

describe('UpsertProviderDocumentResponseSchema', () => {
  it.each(['created', 'updated', 'unchanged'] as const)('parses outcome=%s', (outcome) => {
    const parsed = UpsertProviderDocumentResponseSchema.parse({
      outcome,
      providerId: 'prov_abc',
      indexedAt: ISO_NOW,
      liveMode: false,
    });
    expect(parsed.outcome).toBe(outcome);
  });

  it('rejects unknown outcome', () => {
    expect(() =>
      UpsertProviderDocumentResponseSchema.parse({
        outcome: 'replaced',
        providerId: 'prov_abc',
        indexedAt: ISO_NOW,
        liveMode: false,
      }),
    ).toThrow();
  });
});

describe('DeleteProviderDocumentResponseSchema', () => {
  it('parses deleted outcome', () => {
    const parsed = DeleteProviderDocumentResponseSchema.parse({
      outcome: 'deleted',
      providerId: 'prov_abc',
      deletedAt: ISO_NOW,
      liveMode: false,
    });
    expect(parsed.outcome).toBe('deleted');
  });

  it('parses not_found outcome with null deletedAt', () => {
    const parsed = DeleteProviderDocumentResponseSchema.parse({
      outcome: 'not_found',
      providerId: 'prov_abc',
      deletedAt: null,
      liveMode: false,
    });
    expect(parsed.deletedAt).toBeNull();
  });

  it('rejects unknown outcome', () => {
    expect(() =>
      DeleteProviderDocumentResponseSchema.parse({
        outcome: 'archived',
        providerId: 'prov_abc',
        deletedAt: null,
        liveMode: false,
      }),
    ).toThrow();
  });
});
