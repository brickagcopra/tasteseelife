import type {
  ProviderDiscoveryDocument,
  RecommendProvidersRequest,
  RecommendationSeniorProfile,
  SearchProvidersRequest,
} from '@taste-and-see/contracts';
import { SEARCH_RANKING_REGION_CODE_GLOBAL } from '@taste-and-see/contracts';
import { describe, expect, it, beforeEach } from 'vitest';

import type { Env } from '../../../config/env';
import type {
  ActiveFeaturedPlacement,
  FeaturedPlacementsService,
} from '../../featured-placements/services/featured-placements.service';
import type { RankingConfigService } from '../../ranking-config/services/ranking-config.service';
import {
  DEMENTIA_SPECIALTY_TAGS,
  InMemorySearchBackend,
  RECOMMENDATION_WEIGHT_DEMENTIA,
  RECOMMENDATION_WEIGHT_LANGUAGE,
  computeDistanceKm,
  computeScore,
  geoDecayFactor,
  haversineKm,
  parseOffsetCursor,
  resolveFeaturedBoost,
  scoreRecommendation,
} from './in-memory-search-backend.service';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3020,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'dev',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/search_test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED: true,
    SEARCH_PROVIDER_INDEX_NAME: 'providers_v1',
    SEARCH_TIER_BOOST_BASIC: 1,
    SEARCH_TIER_BOOST_CERTIFIED: 1.5,
    SEARCH_TIER_BOOST_ELITE: 2,
    SEARCH_GEO_DECAY_SCALE_KM: 40.2336,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    SEARCH_INDEX_API_KEY: 'k'.repeat(40),
    OUTBOX_PRODUCER_SERVICE: 'service-search',
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
}

/**
 * Minimal stub `RankingConfigService` for the in-memory backend tests.
 * Only `resolveWeights` is exercised — the search hot path only calls
 * that one method. The stub returns the env-derived weights so the
 * pre-TS-211 test assertions (which exercise tier multipliers via env)
 * keep their behaviour without round-tripping a real DB.
 */
function buildRankingConfig(env: Env): RankingConfigService {
  const stub = {
    resolveWeights: async (
      regionCode: string = SEARCH_RANKING_REGION_CODE_GLOBAL,
    ): Promise<{
      readonly basic: number;
      readonly certified: number;
      readonly elite: number;
      readonly geoDecayScaleKm: number;
      readonly source: 'env';
      readonly regionCode: string;
    }> => {
      await Promise.resolve();
      return {
        basic: env.SEARCH_TIER_BOOST_BASIC,
        certified: env.SEARCH_TIER_BOOST_CERTIFIED,
        elite: env.SEARCH_TIER_BOOST_ELITE,
        geoDecayScaleKm: env.SEARCH_GEO_DECAY_SCALE_KM,
        source: 'env',
        regionCode,
      };
    },
  };
  return stub as unknown as RankingConfigService;
}

/**
 * Minimal stub `FeaturedPlacementsService` for the in-memory backend tests.
 * Only `resolveActivePlacements` is exercised by the search hot path; it
 * returns the supplied (default empty) active set.
 */
function buildFeaturedPlacements(
  placements: readonly ActiveFeaturedPlacement[] = [],
): FeaturedPlacementsService {
  const stub = {
    resolveActivePlacements: async (): Promise<readonly ActiveFeaturedPlacement[]> => {
      await Promise.resolve();
      return placements;
    },
  };
  return stub as unknown as FeaturedPlacementsService;
}

const ISO_T0 = '2026-05-16T12:00:00.000Z';
const ISO_T1 = '2026-05-16T13:00:00.000Z';
const ISO_T2 = '2026-05-16T14:00:00.000Z';

// Manhattan-ish reference centroids (~few km apart)
const MET_MUSEUM = { latitude: 40.7794, longitude: -73.9632 }; // Met Museum
const TIMES_SQUARE = { latitude: 40.758, longitude: -73.9855 }; // Times Square (~2.6 km from Met)
const GOWANUS = { latitude: 40.6726, longitude: -73.9962 }; // Gowanus, BK (~12 km from Met)

function buildDoc(overrides: Partial<ProviderDiscoveryDocument> = {}): ProviderDiscoveryDocument {
  return {
    providerId: overrides.providerId ?? 'prov_abc',
    userId: overrides.userId ?? 'user_abc',
    displayName: overrides.displayName ?? 'Chef Alice',
    headline: overrides.headline ?? 'Italian comfort cuisine',
    bio: overrides.bio ?? 'Twenty years of trattoria experience.',
    tier: overrides.tier ?? 'certified',
    status: overrides.status ?? 'active',
    languages: overrides.languages ?? ['en', 'it'],
    specialties: overrides.specialties ?? ['dementia_sensitive'],
    cuisines: overrides.cuisines ?? ['italian'],
    dietaryExpertise: overrides.dietaryExpertise ?? ['gluten_free'],
    certifications: overrides.certifications ?? ['ccc'],
    centroid: overrides.centroid === undefined ? MET_MUSEUM : overrides.centroid,
    ratingAverage: overrides.ratingAverage === undefined ? 4.7 : overrides.ratingAverage,
    ratingCount: overrides.ratingCount ?? 41,
    completedBookingCount: overrides.completedBookingCount ?? 87,
    profilePhotoKey: overrides.profilePhotoKey ?? null,
    videoIntroKey: overrides.videoIntroKey ?? null,
    timeZone: overrides.timeZone ?? 'America/New_York',
    availabilitySummary:
      overrides.availabilitySummary === undefined ? null : overrides.availabilitySummary,
    sourceUpdatedAt: overrides.sourceUpdatedAt ?? ISO_T1,
  };
}

function emptyRequest(overrides: Partial<SearchProvidersRequest> = {}): SearchProvidersRequest {
  return {
    sort: 'relevance',
    limit: 20,
    ...overrides,
  } as SearchProvidersRequest;
}

describe('InMemorySearchBackend.upsertProvider', () => {
  let backend: InMemorySearchBackend;
  beforeEach(() => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
  });

  it('creates a new doc', async () => {
    const result = await backend.upsertProvider({ document: buildDoc() });
    expect(result.outcome).toBe('created');
    expect(result.providerId).toBe('prov_abc');
  });

  it('updates when sourceUpdatedAt is strictly newer', async () => {
    await backend.upsertProvider({ document: buildDoc({ sourceUpdatedAt: ISO_T0 }) });
    const result = await backend.upsertProvider({
      document: buildDoc({ sourceUpdatedAt: ISO_T1, displayName: 'Chef Alice B.' }),
    });
    expect(result.outcome).toBe('updated');
  });

  it('returns unchanged when sourceUpdatedAt matches', async () => {
    await backend.upsertProvider({ document: buildDoc({ sourceUpdatedAt: ISO_T1 }) });
    const result = await backend.upsertProvider({
      document: buildDoc({ sourceUpdatedAt: ISO_T1 }),
    });
    expect(result.outcome).toBe('unchanged');
  });

  it('returns unchanged when the incoming doc is older (out-of-order delivery)', async () => {
    await backend.upsertProvider({ document: buildDoc({ sourceUpdatedAt: ISO_T2 }) });
    const result = await backend.upsertProvider({
      document: buildDoc({ sourceUpdatedAt: ISO_T1, displayName: 'STALE OVERWRITE' }),
    });
    expect(result.outcome).toBe('unchanged');
    const search = await backend.searchProviders({ request: emptyRequest() });
    expect(search.hits[0]?.document.displayName).toBe('Chef Alice');
  });
});

describe('InMemorySearchBackend.deleteProvider', () => {
  let backend: InMemorySearchBackend;
  beforeEach(() => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
  });

  it('deletes a known doc', async () => {
    await backend.upsertProvider({ document: buildDoc() });
    const result = await backend.deleteProvider({ providerId: 'prov_abc' });
    expect(result.outcome).toBe('deleted');
    expect(result.deletedAt).not.toBeNull();
  });

  it('returns not_found for an unknown doc', async () => {
    const result = await backend.deleteProvider({ providerId: 'prov_ghost' });
    expect(result.outcome).toBe('not_found');
    expect(result.deletedAt).toBeNull();
  });

  it('returns not_found on a repeat delete (idempotent for the indexer)', async () => {
    await backend.upsertProvider({ document: buildDoc() });
    await backend.deleteProvider({ providerId: 'prov_abc' });
    const result = await backend.deleteProvider({ providerId: 'prov_abc' });
    expect(result.outcome).toBe('not_found');
  });
});

describe('InMemorySearchBackend.searchProviders — filters', () => {
  let backend: InMemorySearchBackend;
  beforeEach(async () => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_alice',
        tier: 'elite',
        specialties: ['dementia_sensitive'],
      }),
    });
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_bob',
        tier: 'basic',
        displayName: 'Chef Bob',
        cuisines: ['japanese'],
        specialties: ['therapeutic_meals'],
        certifications: [],
        ratingAverage: 4.0,
      }),
    });
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_carol_inactive',
        tier: 'certified',
        status: 'suspended',
        displayName: 'Chef Carol',
      }),
    });
  });

  it('defaults to active-only', async () => {
    const result = await backend.searchProviders({ request: emptyRequest() });
    expect(result.hits.map((h) => h.document.providerId)).toEqual(['prov_alice', 'prov_bob']);
  });

  it('honours the tier filter', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { tiers: ['elite'] } }),
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.document.providerId).toBe('prov_alice');
  });

  it('honours the language filter', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { languages: ['it'] } }),
    });
    expect(result.hits.every((h) => h.document.languages.includes('it'))).toBe(true);
  });

  it('honours the certification filter', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { certifications: ['ccc'] } }),
    });
    expect(result.hits.every((h) => h.document.certifications.includes('ccc'))).toBe(true);
  });

  it('honours minRating', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { minRating: 4.5 } }),
    });
    expect(result.hits.every((h) => (h.document.ratingAverage ?? 0) >= 4.5)).toBe(true);
  });

  it('drops providers with null rating below minRating', async () => {
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_dan_no_rating', ratingAverage: null }),
    });
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { minRating: 1 } }),
    });
    expect(result.hits.map((h) => h.document.providerId)).not.toContain('prov_dan_no_rating');
  });

  it('allows widened status via explicit filter', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { statuses: ['suspended'] } }),
    });
    expect(result.hits.map((h) => h.document.providerId)).toEqual(['prov_carol_inactive']);
  });

  // TS-215-followup-2 — providerIds filter lets the family-portal
  // /favorites page hydrate a page of favourites in a single
  // round-trip. Membership semantics: pass the list of favourite
  // provider ids, get back only the matching discovery docs.
  it('restricts hits to providers in the providerIds filter', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { providerIds: ['prov_alice'] } }),
    });
    expect(result.hits.map((h) => h.document.providerId)).toEqual(['prov_alice']);
  });

  it('returns an empty hit list when no providerIds match', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { providerIds: ['prov_does_not_exist'] } }),
    });
    expect(result.hits).toHaveLength(0);
    expect(result.totalEstimate).toBe(0);
  });

  it('combines providerIds with the default active-only status filter', async () => {
    // prov_carol_inactive has status=suspended and would be hidden by
    // the default active-only filter; passing its id in providerIds
    // does NOT widen the status gate — the row stays excluded.
    const result = await backend.searchProviders({
      request: emptyRequest({ filters: { providerIds: ['prov_carol_inactive'] } }),
    });
    expect(result.hits).toHaveLength(0);
  });

  it('combines providerIds with an explicit status filter to widen the lens', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({
        filters: {
          providerIds: ['prov_alice', 'prov_carol_inactive'],
          statuses: ['active', 'suspended'],
        },
      }),
    });
    expect(result.hits.map((h) => h.document.providerId).sort()).toEqual([
      'prov_alice',
      'prov_carol_inactive',
    ]);
  });
});

describe('InMemorySearchBackend.searchProviders — text query', () => {
  let backend: InMemorySearchBackend;
  beforeEach(async () => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_alice',
        displayName: 'Alice DePalma',
        headline: 'Italian comfort cuisine',
        cuisines: ['italian'],
      }),
    });
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_bob',
        displayName: 'Bob Tanaka',
        headline: 'Japanese kaiseki',
        cuisines: ['japanese'],
      }),
    });
  });

  it('matches a query token against the displayName', async () => {
    const result = await backend.searchProviders({ request: emptyRequest({ query: 'tanaka' }) });
    expect(result.hits.map((h) => h.document.providerId)).toEqual(['prov_bob']);
  });

  it('matches a query token against a cuisine tag', async () => {
    const result = await backend.searchProviders({ request: emptyRequest({ query: 'italian' }) });
    expect(result.hits.map((h) => h.document.providerId)).toEqual(['prov_alice']);
  });

  it('drops providers when no token overlaps', async () => {
    const result = await backend.searchProviders({ request: emptyRequest({ query: 'sushi' }) });
    expect(result.hits).toEqual([]);
  });
});

describe('InMemorySearchBackend.searchProviders — synonym expansion (TS-216)', () => {
  let backend: InMemorySearchBackend;
  beforeEach(async () => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    // A dementia-experienced provider whose ONLY memory-care signal is the
    // `dementia_sensitive` specialty tag — no "memory" / "care" anywhere else.
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_dem',
        displayName: 'Dana Russo',
        headline: 'Warm family dinners',
        bio: 'Trattoria trained.',
        specialties: ['dementia_sensitive'],
        cuisines: ['italian'],
        dietaryExpertise: [],
      }),
    });
    // A control with no dementia signal at all.
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_ctrl',
        displayName: 'Ken Sato',
        headline: 'Kaiseki tasting menus',
        bio: 'Tokyo trained.',
        specialties: ['therapeutic_meals'],
        cuisines: ['japanese'],
        dietaryExpertise: [],
      }),
    });
    // A provider whose bio literally contains the generic word "care".
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_care',
        displayName: 'Pat Lane',
        headline: 'Gentle companion meals',
        bio: 'Compassionate in-home care.',
        specialties: [],
        cuisines: [],
        dietaryExpertise: [],
      }),
    });
    // A kosher provider whose only religious-dietary signal is the tag.
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_kosher',
        displayName: 'Miriam Gold',
        headline: 'Shabbat dinners',
        bio: 'Family recipes.',
        specialties: [],
        cuisines: ['jewish'],
        dietaryExpertise: ['kosher'],
      }),
    });
  });

  it('surfaces a `dementia`-tagged provider for a "memory care" query', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ query: 'memory care' }),
    });
    const ids = result.hits.map((h) => h.document.providerId);
    expect(ids).toContain('prov_dem');
    expect(ids).not.toContain('prov_ctrl');
  });

  it('does NOT expand a bare generic "care" query into the dementia synonym set', async () => {
    // "care" alone never fires the "memory care" member (phrase containment),
    // so only the provider whose bio literally says "care" matches.
    const result = await backend.searchProviders({ request: emptyRequest({ query: 'care' }) });
    const ids = result.hits.map((h) => h.document.providerId);
    expect(ids).toEqual(['prov_care']);
  });

  it('surfaces a `kosher` provider for a "religious dietary" query', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ query: 'religious dietary' }),
    });
    const ids = result.hits.map((h) => h.document.providerId);
    expect(ids).toContain('prov_kosher');
    expect(ids).not.toContain('prov_dem');
  });

  it('ranks a synonym match above a non-match (synonym hit counts toward score)', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ query: 'alzheimers' }),
    });
    // `alzheimers` expands to the dementia group, so the dementia provider
    // (tagged `dementia_sensitive`) leads; the control never matches.
    expect(result.hits[0]?.document.providerId).toBe('prov_dem');
    expect(result.hits.map((h) => h.document.providerId)).not.toContain('prov_ctrl');
  });
});

describe('InMemorySearchBackend.searchProviders — geo', () => {
  let backend: InMemorySearchBackend;
  beforeEach(async () => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_met', centroid: MET_MUSEUM }),
    });
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_times', centroid: TIMES_SQUARE }),
    });
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_gowanus', centroid: GOWANUS }),
    });
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_no_geo', centroid: null }),
    });
  });

  it('drops providers outside the radius', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({
        geo: { center: MET_MUSEUM, radiusKm: 5 },
      }),
    });
    const ids = result.hits.map((h) => h.document.providerId);
    expect(ids).toContain('prov_met');
    expect(ids).toContain('prov_times');
    expect(ids).not.toContain('prov_gowanus');
    expect(ids).not.toContain('prov_no_geo');
  });

  it('reports distance on every hit when geo is supplied', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ geo: { center: MET_MUSEUM, radiusKm: 50 } }),
    });
    for (const hit of result.hits) {
      expect(hit.distanceKm).not.toBeNull();
    }
  });

  it('reports null distance when geo is omitted', async () => {
    const result = await backend.searchProviders({ request: emptyRequest() });
    for (const hit of result.hits) {
      expect(hit.distanceKm).toBeNull();
    }
  });

  it('sorts by distance when sort=distance', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({
        sort: 'distance',
        geo: { center: MET_MUSEUM, radiusKm: 50 },
      }),
    });
    const ids = result.hits.map((h) => h.document.providerId);
    expect(ids[0]).toBe('prov_met');
    expect(ids[1]).toBe('prov_times');
    expect(ids[2]).toBe('prov_gowanus');
  });
});

describe('InMemorySearchBackend.searchProviders — geo-distance decay (TS-210)', () => {
  // Two providers identical in every score input (tier / rating /
  // popularity / query) but at different distances from the search
  // center, so any ranking difference is attributable to the geo decay.
  function seed(backend: InMemorySearchBackend): Promise<void[]> {
    return Promise.all([
      backend
        .upsertProvider({ document: buildDoc({ providerId: 'prov_near', centroid: MET_MUSEUM }) })
        .then(() => undefined),
      backend
        .upsertProvider({ document: buildDoc({ providerId: 'prov_far', centroid: GOWANUS }) })
        .then(() => undefined),
    ]);
  }

  it('ranks the nearer provider above an otherwise-identical far one on relevance sort', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    await seed(backend);
    const result = await backend.searchProviders({
      request: emptyRequest({ geo: { center: MET_MUSEUM, radiusKm: 50 } }),
    });
    expect(result.hits.map((h) => h.document.providerId)).toEqual(['prov_near', 'prov_far']);
    const near = result.hits.find((h) => h.document.providerId === 'prov_near');
    const far = result.hits.find((h) => h.document.providerId === 'prov_far');
    expect(near?.score ?? 0).toBeGreaterThan(far?.score ?? 0);
  });

  it('does not let distance affect relevance scores when no geo center is supplied', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    await seed(backend);
    const result = await backend.searchProviders({ request: emptyRequest() });
    const near = result.hits.find((h) => h.document.providerId === 'prov_near');
    const far = result.hits.find((h) => h.document.providerId === 'prov_far');
    // Identical score inputs + no geo decay ⇒ equal scores.
    expect(near?.score).toBe(far?.score);
  });

  it('still applies the decay to scores even under the explicit distance sort', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    await seed(backend);
    const result = await backend.searchProviders({
      request: emptyRequest({ sort: 'distance', geo: { center: MET_MUSEUM, radiusKm: 50 } }),
    });
    // Distance sort orders by raw distance (near first) regardless of score…
    expect(result.hits.map((h) => h.document.providerId)).toEqual(['prov_near', 'prov_far']);
    // …but the score itself still carries the decay (far < near).
    const near = result.hits.find((h) => h.document.providerId === 'prov_near');
    const far = result.hits.find((h) => h.document.providerId === 'prov_far');
    expect(far?.score ?? 0).toBeLessThan(near?.score ?? 0);
  });

  it('penalizes distance more aggressively with a smaller configured decay scale', async () => {
    const wide = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    const tight = new InMemorySearchBackend(
      buildRankingConfig(buildEnv({ SEARCH_GEO_DECAY_SCALE_KM: 5 })),
      buildFeaturedPlacements(),
    );
    await wide.upsertProvider({
      document: buildDoc({ providerId: 'prov_far', centroid: GOWANUS }),
    });
    await tight.upsertProvider({
      document: buildDoc({ providerId: 'prov_far', centroid: GOWANUS }),
    });

    const geoReq = emptyRequest({ geo: { center: MET_MUSEUM, radiusKm: 50 } });
    const wideHit = (await wide.searchProviders({ request: geoReq })).hits[0];
    const tightHit = (await tight.searchProviders({ request: geoReq })).hits[0];
    expect(tightHit?.score ?? 0).toBeLessThan(wideHit?.score ?? 0);
  });
});

describe('InMemorySearchBackend.searchProviders — sort & pagination', () => {
  let backend: InMemorySearchBackend;
  beforeEach(async () => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    for (let i = 0; i < 5; i += 1) {
      await backend.upsertProvider({
        document: buildDoc({
          providerId: `prov_${i}`,
          ratingAverage: 4.0 + i * 0.1,
          ratingCount: 10 * (i + 1),
          completedBookingCount: 50 + i,
        }),
      });
    }
  });

  it('sorts by rating descending when sort=rating', async () => {
    const result = await backend.searchProviders({
      request: emptyRequest({ sort: 'rating' }),
    });
    const ratings = result.hits.map((h) => h.document.ratingAverage ?? 0);
    for (let i = 1; i < ratings.length; i += 1) {
      expect(ratings[i - 1]).toBeGreaterThanOrEqual(ratings[i] ?? 0);
    }
  });

  it('paginates with a cursor', async () => {
    const first = await backend.searchProviders({ request: emptyRequest({ limit: 2 }) });
    expect(first.hits).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await backend.searchProviders({
      request: emptyRequest({ limit: 2, cursor: first.nextCursor ?? undefined }),
    });
    expect(second.hits).toHaveLength(2);
    // First page IDs and second page IDs must not overlap.
    const firstIds = new Set(first.hits.map((h) => h.document.providerId));
    for (const hit of second.hits) {
      expect(firstIds.has(hit.document.providerId)).toBe(false);
    }
  });

  it('returns nextCursor=null on the last page', async () => {
    const result = await backend.searchProviders({ request: emptyRequest({ limit: 100 }) });
    expect(result.nextCursor).toBeNull();
  });

  it('reports totalEstimate as the unpaginated filtered count', async () => {
    const result = await backend.searchProviders({ request: emptyRequest({ limit: 2 }) });
    expect(result.totalEstimate).toBe(5);
  });
});

describe('InMemorySearchBackend.searchProviders — facets', () => {
  let backend: InMemorySearchBackend;
  beforeEach(async () => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'p1',
        tier: 'elite',
        languages: ['en'],
        specialties: ['dementia_sensitive'],
      }),
    });
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'p2',
        tier: 'elite',
        languages: ['en', 'es'],
        specialties: ['therapeutic_meals'],
      }),
    });
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'p3',
        tier: 'basic',
        languages: ['es'],
        specialties: ['dementia_sensitive'],
      }),
    });
  });

  it('reports tier buckets with counts', async () => {
    const result = await backend.searchProviders({ request: emptyRequest() });
    const tiers = Object.fromEntries(result.facets.tiers.map((b) => [b.value, b.count]));
    expect(tiers['elite']).toBe(2);
    expect(tiers['basic']).toBe(1);
  });

  it('reports language buckets summed across docs', async () => {
    const result = await backend.searchProviders({ request: emptyRequest() });
    const langs = Object.fromEntries(result.facets.languages.map((b) => [b.value, b.count]));
    expect(langs['en']).toBe(2);
    expect(langs['es']).toBe(2);
  });

  it('reports specialty buckets', async () => {
    const result = await backend.searchProviders({ request: emptyRequest() });
    const specs = Object.fromEntries(result.facets.specialties.map((b) => [b.value, b.count]));
    expect(specs['dementia_sensitive']).toBe(2);
    expect(specs['therapeutic_meals']).toBe(1);
  });
});

describe('InMemorySearchBackend.searchProviders — tier-boost ranking', () => {
  it('boosts elite over basic with default weights', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_elite',
        tier: 'elite',
        ratingAverage: 4.0,
        ratingCount: 20,
      }),
    });
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_basic',
        tier: 'basic',
        ratingAverage: 4.0,
        ratingCount: 20,
      }),
    });
    const result = await backend.searchProviders({ request: emptyRequest() });
    expect(result.hits[0]?.document.tier).toBe('elite');
    expect(result.hits[1]?.document.tier).toBe('basic');
  });
});

describe('helpers', () => {
  it('haversineKm — same point returns 0', () => {
    expect(haversineKm(MET_MUSEUM, MET_MUSEUM)).toBeCloseTo(0, 5);
  });

  it('haversineKm — Met → Gowanus ≈ 12 km', () => {
    const km = haversineKm(MET_MUSEUM, GOWANUS);
    expect(km).toBeGreaterThan(10);
    expect(km).toBeLessThan(15);
  });

  it('computeDistanceKm returns Infinity for null centroid', () => {
    const doc = buildDoc({ centroid: null });
    expect(computeDistanceKm(doc, MET_MUSEUM)).toBe(Number.POSITIVE_INFINITY);
  });

  it('computeScore — same provider with elite tier scores higher than basic tier', () => {
    const elite = buildDoc({ tier: 'elite' });
    const basic = buildDoc({ tier: 'basic' });
    expect(computeScore(elite, undefined, 2)).toBeGreaterThan(computeScore(basic, undefined, 1));
  });

  it('computeScore — query overlap adds to score', () => {
    const doc = buildDoc({ displayName: 'Chef Alice', cuisines: ['italian'] });
    const noMatch = computeScore(doc, undefined, 1.5);
    const match = computeScore(doc, 'italian', 1.5);
    expect(match).toBeGreaterThan(noMatch);
  });

  it('parseOffsetCursor — handles undefined / valid / invalid forms', () => {
    expect(parseOffsetCursor(undefined)).toBe(0);
    expect(parseOffsetCursor('offset:5')).toBe(5);
    expect(parseOffsetCursor('offset:-1')).toBe(0);
    expect(parseOffsetCursor('garbage')).toBe(0);
    expect(parseOffsetCursor('offset:abc')).toBe(0);
  });

  it('geoDecayFactor — is 1 at distance 0 and decays to 1/e at one scale length', () => {
    expect(geoDecayFactor(0, 40.2336)).toBe(1);
    expect(geoDecayFactor(40.2336, 40.2336)).toBeCloseTo(Math.exp(-1), 6);
  });

  it('geoDecayFactor — decreases monotonically with distance and stays in (0, 1)', () => {
    const near = geoDecayFactor(10, 40.2336);
    const far = geoDecayFactor(20, 40.2336);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThan(1);
    expect(far).toBeGreaterThan(0);
  });

  it('geoDecayFactor — returns 1 (no decay) for null, non-finite, or non-positive inputs', () => {
    expect(geoDecayFactor(null, 40.2336)).toBe(1);
    expect(geoDecayFactor(Number.POSITIVE_INFINITY, 40.2336)).toBe(1);
    expect(geoDecayFactor(-5, 40.2336)).toBe(1);
    expect(geoDecayFactor(10, 0)).toBe(1);
    expect(geoDecayFactor(10, -1)).toBe(1);
  });
});

describe('InMemorySearchBackend metadata', () => {
  it('reports isLiveMode=false', () => {
    expect(
      new InMemorySearchBackend(
        buildRankingConfig(buildEnv()),
        buildFeaturedPlacements(),
      ).isLiveMode(),
    ).toBe(false);
  });

  it('ping resolves cleanly', async () => {
    await expect(
      new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements()).ping(),
    ).resolves.toBeUndefined();
  });

  it('resetForTesting wipes the index', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    await backend.upsertProvider({ document: buildDoc() });
    backend.resetForTesting();
    const result = await backend.searchProviders({ request: emptyRequest() });
    expect(result.hits).toEqual([]);
  });
});

describe('resolveFeaturedBoost (TS-207)', () => {
  it('returns 1 when no placements are active', () => {
    expect(resolveFeaturedBoost(buildDoc({ providerId: 'prov_abc' }), [])).toBe(1);
  });

  it('applies a region-agnostic, tier-agnostic placement to the matching provider', () => {
    const boost = resolveFeaturedBoost(buildDoc({ providerId: 'prov_abc', tier: 'basic' }), [
      { providerId: 'prov_abc', regionCode: null, tier: null, boostMultiplier: 2.5 },
    ]);
    expect(boost).toBe(2.5);
  });

  it('ignores a placement for a different provider', () => {
    const boost = resolveFeaturedBoost(buildDoc({ providerId: 'prov_abc' }), [
      { providerId: 'prov_other', regionCode: null, tier: null, boostMultiplier: 3 },
    ]);
    expect(boost).toBe(1);
  });

  it('honours a tier-scoped placement only when the tier matches', () => {
    const placement = {
      providerId: 'prov_abc',
      regionCode: null,
      tier: 'elite',
      boostMultiplier: 2,
    };
    expect(
      resolveFeaturedBoost(buildDoc({ providerId: 'prov_abc', tier: 'elite' }), [placement]),
    ).toBe(2);
    expect(
      resolveFeaturedBoost(buildDoc({ providerId: 'prov_abc', tier: 'basic' }), [placement]),
    ).toBe(1);
  });

  it('skips a region-scoped placement in Phase 1 (no request region resolution)', () => {
    const boost = resolveFeaturedBoost(buildDoc({ providerId: 'prov_abc' }), [
      { providerId: 'prov_abc', regionCode: 'nyc', tier: null, boostMultiplier: 4 },
    ]);
    expect(boost).toBe(1);
  });

  it('takes the MAX boost among multiple matching placements', () => {
    const boost = resolveFeaturedBoost(buildDoc({ providerId: 'prov_abc', tier: 'certified' }), [
      { providerId: 'prov_abc', regionCode: null, tier: null, boostMultiplier: 2 },
      { providerId: 'prov_abc', regionCode: null, tier: 'certified', boostMultiplier: 3.5 },
    ]);
    expect(boost).toBe(3.5);
  });
});

describe('InMemorySearchBackend.searchProviders featured boost (TS-207)', () => {
  it('boosts a featured provider above an unfeatured one + flags the hit', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements([
        { providerId: 'prov_featured', regionCode: null, tier: null, boostMultiplier: 5 },
      ]),
    );
    // Two identical-tier docs; the featured one would otherwise tie on score.
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_plain', tier: 'basic', centroid: null }),
    });
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_featured', tier: 'basic', centroid: null }),
    });

    const result = await backend.searchProviders({ request: emptyRequest() });
    expect(result.hits[0]?.document.providerId).toBe('prov_featured');
    expect(result.hits[0]?.featured).toBe(true);
    const plain = result.hits.find((h) => h.document.providerId === 'prov_plain');
    expect(plain?.featured).toBe(false);
  });
});

function buildProfile(
  overrides: Partial<RecommendationSeniorProfile> = {},
): RecommendationSeniorProfile {
  return {
    languages: overrides.languages ?? [],
    dietaryTags: overrides.dietaryTags ?? [],
    cuisinePreferences: overrides.cuisinePreferences ?? [],
    dementiaSensitive: overrides.dementiaSensitive ?? false,
  };
}

function recommendRequest(
  profile: RecommendationSeniorProfile,
  limit = 10,
): RecommendProvidersRequest {
  return { profile, limit };
}

describe('scoreRecommendation (TS-213)', () => {
  it('emits a language signal when the senior + provider share a language', () => {
    const doc = buildDoc({ languages: ['en', 'es'] });
    const result = scoreRecommendation(doc, buildProfile({ languages: ['es'] }), 1);
    const language = result.signals.find((s) => s.kind === 'language');
    expect(language?.matchedValues).toEqual(['es']);
    expect(language?.contribution).toBe(RECOMMENDATION_WEIGHT_LANGUAGE);
  });

  it('emits no match signal when there is no overlap on a facet', () => {
    const doc = buildDoc({
      languages: ['en'],
      dietaryExpertise: ['gluten_free'],
      cuisines: ['italian'],
    });
    const result = scoreRecommendation(
      doc,
      buildProfile({ languages: ['fr'], dietaryTags: ['kosher'], cuisinePreferences: ['thai'] }),
      1,
    );
    expect(result.signals.some((s) => s.kind === 'language')).toBe(false);
    expect(result.signals.some((s) => s.kind === 'dietary')).toBe(false);
    expect(result.signals.some((s) => s.kind === 'cuisine')).toBe(false);
  });

  it('always emits the rating / popularity / tier quality baselines', () => {
    const result = scoreRecommendation(buildDoc(), buildProfile(), 1.5);
    expect(result.signals.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['rating', 'popularity', 'tier']),
    );
    // Even with zero preference matches the score is the positive quality sum.
    expect(result.score).toBeGreaterThan(0);
  });

  it('emits a dementia_experience signal when the senior needs it and the provider carries the specialty', () => {
    const doc = buildDoc({ specialties: ['dementia_sensitive'] });
    const result = scoreRecommendation(doc, buildProfile({ dementiaSensitive: true }), 1);
    const dementia = result.signals.find((s) => s.kind === 'dementia_experience');
    expect(dementia?.contribution).toBe(RECOMMENDATION_WEIGHT_DEMENTIA);
    expect(dementia?.matchedValues).toEqual(['dementia_sensitive']);
  });

  it('omits the dementia signal when the provider has no memory-care specialty', () => {
    const doc = buildDoc({ specialties: ['therapeutic_meals'] });
    const result = scoreRecommendation(doc, buildProfile({ dementiaSensitive: true }), 1);
    expect(result.signals.some((s) => s.kind === 'dementia_experience')).toBe(false);
  });

  it('omits the dementia signal when the senior does not need it even if the provider has it', () => {
    const doc = buildDoc({ specialties: DEMENTIA_SPECIALTY_TAGS.slice(0, 1) });
    const result = scoreRecommendation(doc, buildProfile({ dementiaSensitive: false }), 1);
    expect(result.signals.some((s) => s.kind === 'dementia_experience')).toBe(false);
  });

  it('score equals the sum of every signal contribution', () => {
    const doc = buildDoc({ languages: ['es'], cuisines: ['italian'] });
    const result = scoreRecommendation(
      doc,
      buildProfile({ languages: ['es'], cuisinePreferences: ['italian'] }),
      2,
    );
    const sum = result.signals.reduce((acc, s) => acc + s.contribution, 0);
    expect(result.score).toBeCloseTo(sum, 10);
  });
});

describe('InMemorySearchBackend.recommendProviders (TS-213)', () => {
  let backend: InMemorySearchBackend;
  beforeEach(() => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
  });

  it('ranks a well-matched basic provider above a quality-only elite provider', async () => {
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_match',
        tier: 'basic',
        languages: ['es'],
        cuisines: ['italian'],
        dietaryExpertise: ['kosher'],
        ratingAverage: 4.0,
        completedBookingCount: 10,
      }),
    });
    await backend.upsertProvider({
      document: buildDoc({
        providerId: 'prov_elite',
        tier: 'elite',
        languages: ['en'],
        cuisines: ['french'],
        dietaryExpertise: ['vegan'],
        ratingAverage: 5.0,
        completedBookingCount: 200,
      }),
    });

    const { recommendations } = await backend.recommendProviders({
      request: recommendRequest(
        buildProfile({
          languages: ['es'],
          cuisinePreferences: ['italian'],
          dietaryTags: ['kosher'],
        }),
      ),
    });
    expect(recommendations[0]?.document.providerId).toBe('prov_match');
  });

  it('excludes non-active providers', async () => {
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_active', status: 'active' }),
    });
    await backend.upsertProvider({
      document: buildDoc({ providerId: 'prov_suspended', status: 'suspended' }),
    });
    const { recommendations } = await backend.recommendProviders({
      request: recommendRequest(buildProfile()),
    });
    expect(recommendations.map((r) => r.document.providerId)).toEqual(['prov_active']);
  });

  it('returns at most `limit` recommendations', async () => {
    for (let i = 0; i < 5; i += 1) {
      await backend.upsertProvider({ document: buildDoc({ providerId: `prov_${i}` }) });
    }
    const { recommendations } = await backend.recommendProviders({
      request: recommendRequest(buildProfile(), 3),
    });
    expect(recommendations).toHaveLength(3);
  });

  it('returns every active provider even with an empty profile (quality-only ranking)', async () => {
    await backend.upsertProvider({ document: buildDoc({ providerId: 'p1' }) });
    await backend.upsertProvider({ document: buildDoc({ providerId: 'p2' }) });
    const { recommendations } = await backend.recommendProviders({
      request: recommendRequest(buildProfile()),
    });
    expect(recommendations).toHaveLength(2);
    expect(recommendations.every((r) => r.score > 0)).toBe(true);
  });

  it('returns an empty list when no providers are indexed', async () => {
    const { recommendations } = await backend.recommendProviders({
      request: recommendRequest(buildProfile()),
    });
    expect(recommendations).toEqual([]);
  });
});
