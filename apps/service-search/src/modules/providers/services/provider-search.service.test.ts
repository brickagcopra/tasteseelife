import type {
  AdTargetingAudience,
  ProviderDiscoveryDocument,
  SponsoredListing,
} from '@taste-and-see/contracts';
import { SEARCH_RANKING_REGION_CODE_GLOBAL } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import type {
  ActiveFeaturedPlacement,
  FeaturedPlacementsService,
} from '../../featured-placements/services/featured-placements.service';
import type { RankingConfigService } from '../../ranking-config/services/ranking-config.service';
import { InMemorySearchBackend } from './in-memory-search-backend.service';
import { ProviderSearchService } from './provider-search.service';
import type { SearchBackend } from './search-backend';
import {
  SearchMetrics,
  type SearchDeleteOutcome,
  type SearchQueryOutcome,
  type SearchSortLabel,
  type SearchUpsertOutcome,
} from './search-metrics';
import type { SponsoredListingsClient } from './sponsored-listings.client';

/**
 * Stub sponsored-listings client (TS-218b). Returns the canned `listings`
 * and records every resolve call so tests can assert the resolve was (or was
 * not) invoked. The real client's HTTP/fail-open behaviour is covered in its
 * own suite.
 */
function buildSponsoredClient(listings: readonly SponsoredListing[] = []): {
  readonly client: SponsoredListingsClient;
  readonly calls: Array<{ readonly candidateProviderIds: readonly string[] }>;
} {
  const calls: Array<{ readonly candidateProviderIds: readonly string[] }> = [];
  const client = {
    resolve: async (input: {
      readonly audience: AdTargetingAudience;
      readonly candidateProviderIds: readonly string[];
    }): Promise<readonly SponsoredListing[]> => {
      calls.push({ candidateProviderIds: input.candidateProviderIds });
      await Promise.resolve();
      return listings;
    },
  } as unknown as SponsoredListingsClient;
  return { client, calls };
}

const EMPTY_AUDIENCE: AdTargetingAudience = { behaviorCohorts: [] };

/**
 * Real `SearchMetrics` over the no-op meter (the OTel SDK is not booted in
 * unit tests, so `getMeter` returns a no-op meter and every `add` / `record`
 * / observable callback is a safe no-op). Used wherever a test does not need
 * to assert on the recorded values.
 */
function buildMetrics(backend: SearchBackend): SearchMetrics {
  return new SearchMetrics(backend);
}

/**
 * Recording fake `SearchMetrics` capturing every `record*` call so the
 * metric-wiring tests can assert the service emits the right labels.
 */
function buildRecordingMetrics(): {
  readonly metrics: SearchMetrics;
  readonly queries: Array<{
    readonly outcome: SearchQueryOutcome;
    readonly sort: SearchSortLabel;
    readonly liveMode: boolean;
  }>;
  readonly upserts: SearchUpsertOutcome[];
  readonly deletes: SearchDeleteOutcome[];
} {
  const queries: Array<{
    readonly outcome: SearchQueryOutcome;
    readonly sort: SearchSortLabel;
    readonly liveMode: boolean;
  }> = [];
  const upserts: SearchUpsertOutcome[] = [];
  const deletes: SearchDeleteOutcome[] = [];
  const metrics = {
    recordQuery: (input: {
      readonly outcome: SearchQueryOutcome;
      readonly sort: SearchSortLabel;
      readonly liveMode: boolean;
      readonly seconds: number;
    }): void => {
      queries.push({ outcome: input.outcome, sort: input.sort, liveMode: input.liveMode });
    },
    recordUpsert: (outcome: SearchUpsertOutcome): void => {
      upserts.push(outcome);
    },
    recordDelete: (outcome: SearchDeleteOutcome): void => {
      deletes.push(outcome);
    },
  } as unknown as SearchMetrics;
  return { metrics, queries, upserts, deletes };
}

function buildEnv(): Env {
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
    SEARCH_TIER_BOOST_CERTIFIED: 1.2,
    SEARCH_TIER_BOOST_ELITE: 1.5,
    SEARCH_GEO_DECAY_SCALE_KM: 40.2336,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    SEARCH_INDEX_API_KEY: 'k'.repeat(40),
    OUTBOX_PRODUCER_SERVICE: 'service-search',
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
  };
}

function buildRankingConfig(env: Env): RankingConfigService {
  const stub = {
    resolveWeights: async (
      regionCode: string = SEARCH_RANKING_REGION_CODE_GLOBAL,
    ): Promise<{
      readonly basic: number;
      readonly certified: number;
      readonly elite: number;
      readonly source: 'env';
      readonly regionCode: string;
    }> => {
      await Promise.resolve();
      return {
        basic: env.SEARCH_TIER_BOOST_BASIC,
        certified: env.SEARCH_TIER_BOOST_CERTIFIED,
        elite: env.SEARCH_TIER_BOOST_ELITE,
        source: 'env',
        regionCode,
      };
    },
  };
  return stub as unknown as RankingConfigService;
}

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

const ISO_NOW = '2026-05-16T12:00:00.000Z';

function buildDoc(overrides: Partial<ProviderDiscoveryDocument> = {}): ProviderDiscoveryDocument {
  return {
    providerId: 'prov_abc',
    userId: 'user_abc',
    displayName: 'Chef Alice',
    headline: null,
    bio: null,
    tier: 'certified',
    status: 'active',
    languages: ['en'],
    specialties: [],
    cuisines: [],
    dietaryExpertise: [],
    certifications: [],
    centroid: null,
    ratingAverage: null,
    ratingCount: 0,
    completedBookingCount: 0,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    availabilitySummary: null,
    sourceUpdatedAt: ISO_NOW,
    ...overrides,
  };
}

describe('ProviderSearchService.search', () => {
  let backend: InMemorySearchBackend;
  let service: ProviderSearchService;

  beforeEach(() => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    service = new ProviderSearchService(
      backend,
      buildSponsoredClient().client,
      buildMetrics(backend),
    );
  });

  it('returns liveMode=false in stub mode with empty hits', async () => {
    const response = await service.search({ sort: 'relevance', limit: 20 });
    expect(response.liveMode).toBe(false);
    expect(response.hits).toEqual([]);
    expect(response.totalEstimate).toBe(0);
    expect(response.nextCursor).toBeNull();
  });

  it('shapes hits onto the wire contract', async () => {
    await backend.upsertProvider({ document: buildDoc() });
    const response = await service.search({ sort: 'relevance', limit: 20 });
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]?.document.providerId).toBe('prov_abc');
    expect(typeof response.hits[0]?.score).toBe('number');
    expect(response.hits[0]?.distanceKm).toBeNull();
    expect(response.hits[0]?.featured).toBe(false);
    expect(response.hits[0]?.sponsored).toBeNull();
  });

  it('flags a hit as featured when an active placement matches (TS-207)', async () => {
    const featuredBackend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements([
        { providerId: 'prov_abc', regionCode: null, tier: null, boostMultiplier: 3 },
      ]),
    );
    const featuredService = new ProviderSearchService(
      featuredBackend,
      buildSponsoredClient().client,
      buildMetrics(featuredBackend),
    );
    await featuredBackend.upsertProvider({ document: buildDoc() });
    const response = await featuredService.search({ sort: 'relevance', limit: 20 });
    expect(response.hits[0]?.featured).toBe(true);
  });

  // ─── TS-218b — sponsored slot reservation ─────────────────────────────

  it('reserves the top slot for a resolved sponsored provider (TS-218b)', async () => {
    await backend.upsertProvider({ document: buildDoc({ providerId: 'prov_a' }) });
    await backend.upsertProvider({ document: buildDoc({ providerId: 'prov_b' }) });
    const { client, calls } = buildSponsoredClient([
      { providerId: 'prov_b', campaignId: 'camp_1', creativeId: 'crv_1' },
    ]);
    const sponsoredService = new ProviderSearchService(backend, client, buildMetrics(backend));

    const response = await sponsoredService.search(
      { sort: 'relevance', limit: 20 },
      { audience: EMPTY_AUDIENCE },
    );

    // The resolve was given every organic candidate id.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.candidateProviderIds).toEqual(expect.arrayContaining(['prov_a', 'prov_b']));
    // The sponsored provider is promoted to the top slot + flagged.
    expect(response.hits[0]?.document.providerId).toBe('prov_b');
    expect(response.hits[0]?.sponsored).toEqual({ campaignId: 'camp_1', creativeId: 'crv_1' });
    // The organic provider follows, still unsponsored.
    const organic = response.hits.find((hit) => hit.document.providerId === 'prov_a');
    expect(organic?.sponsored).toBeNull();
  });

  it('skips the sponsored resolve on a paged request (TS-218b)', async () => {
    await backend.upsertProvider({ document: buildDoc({ providerId: 'prov_a' }) });
    const { client, calls } = buildSponsoredClient([
      { providerId: 'prov_a', campaignId: 'c', creativeId: 'v' },
    ]);
    const sponsoredService = new ProviderSearchService(backend, client, buildMetrics(backend));

    const response = await sponsoredService.search(
      { sort: 'relevance', limit: 20, cursor: 'offset:0' },
      { audience: EMPTY_AUDIENCE },
    );

    expect(calls).toHaveLength(0);
    expect(response.hits[0]?.sponsored).toBeNull();
  });

  it('does not resolve sponsored slots when no audience is supplied (TS-218b)', async () => {
    await backend.upsertProvider({ document: buildDoc({ providerId: 'prov_a' }) });
    const { client, calls } = buildSponsoredClient([
      { providerId: 'prov_a', campaignId: 'c', creativeId: 'v' },
    ]);
    const sponsoredService = new ProviderSearchService(backend, client, buildMetrics(backend));

    const response = await sponsoredService.search({ sort: 'relevance', limit: 20 });

    expect(calls).toHaveLength(0);
    expect(response.hits[0]?.sponsored).toBeNull();
  });

  it('leaves organic results unchanged when the resolve returns nothing (TS-218b)', async () => {
    await backend.upsertProvider({ document: buildDoc({ providerId: 'prov_a' }) });
    const sponsoredService = new ProviderSearchService(
      backend,
      buildSponsoredClient([]).client,
      buildMetrics(backend),
    );

    const response = await sponsoredService.search(
      { sort: 'relevance', limit: 20 },
      { audience: EMPTY_AUDIENCE },
    );

    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]?.sponsored).toBeNull();
  });
});

describe('ProviderSearchService.upsertProvider', () => {
  let backend: InMemorySearchBackend;
  let service: ProviderSearchService;

  beforeEach(() => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
    service = new ProviderSearchService(
      backend,
      buildSponsoredClient().client,
      buildMetrics(backend),
    );
  });

  it('creates on first upsert', async () => {
    const result = await service.upsertProvider({
      providerIdPath: 'prov_abc',
      document: buildDoc(),
    });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.response.outcome).toBe('created');
      expect(result.response.liveMode).toBe(false);
    }
  });

  it('rejects path mismatch', async () => {
    const result = await service.upsertProvider({
      providerIdPath: 'prov_xyz',
      document: buildDoc({ providerId: 'prov_abc' }),
    });
    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.failure).toBe('provider_id_mismatch');
    }
  });

  it('returns outcome=updated on a newer source timestamp', async () => {
    await service.upsertProvider({
      providerIdPath: 'prov_abc',
      document: buildDoc({ sourceUpdatedAt: '2026-05-16T11:00:00.000Z' }),
    });
    const second = await service.upsertProvider({
      providerIdPath: 'prov_abc',
      document: buildDoc({ sourceUpdatedAt: '2026-05-16T13:00:00.000Z' }),
    });
    expect(second.kind).toBe('success');
    if (second.kind === 'success') {
      expect(second.response.outcome).toBe('updated');
    }
  });
});

describe('ProviderSearchService.deleteProvider', () => {
  it('returns deleted+timestamp for an existing doc', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    const service = new ProviderSearchService(
      backend,
      buildSponsoredClient().client,
      buildMetrics(backend),
    );
    await backend.upsertProvider({ document: buildDoc() });
    const result = await service.deleteProvider({ providerId: 'prov_abc' });
    expect(result.outcome).toBe('deleted');
    expect(result.deletedAt).not.toBeNull();
    expect(result.liveMode).toBe(false);
  });

  it('returns not_found+null for a missing doc', async () => {
    const backend = new InMemorySearchBackend(
      buildRankingConfig(buildEnv()),
      buildFeaturedPlacements(),
    );
    const service = new ProviderSearchService(
      backend,
      buildSponsoredClient().client,
      buildMetrics(backend),
    );
    const result = await service.deleteProvider({ providerId: 'prov_ghost' });
    expect(result.outcome).toBe('not_found');
    expect(result.deletedAt).toBeNull();
  });
});

// ─── TS-111-followup-4 — metric wiring ──────────────────────────────────

describe('ProviderSearchService metric wiring (TS-111-followup-4)', () => {
  let backend: InMemorySearchBackend;

  beforeEach(() => {
    backend = new InMemorySearchBackend(buildRankingConfig(buildEnv()), buildFeaturedPlacements());
  });

  it('records query outcome=empty + sort + stub liveMode on a no-hit search', async () => {
    const { metrics, queries } = buildRecordingMetrics();
    const service = new ProviderSearchService(backend, buildSponsoredClient().client, metrics);
    await service.search({ sort: 'rating', limit: 20 });
    expect(queries).toEqual([{ outcome: 'empty', sort: 'rating', liveMode: false }]);
  });

  it('records query outcome=ok when the page has hits', async () => {
    await backend.upsertProvider({ document: buildDoc() });
    const { metrics, queries } = buildRecordingMetrics();
    const service = new ProviderSearchService(backend, buildSponsoredClient().client, metrics);
    await service.search({ sort: 'relevance', limit: 20 });
    expect(queries).toEqual([{ outcome: 'ok', sort: 'relevance', liveMode: false }]);
  });

  it('records upsert outcomes (created → unchanged) and provider_id_mismatch', async () => {
    const { metrics, upserts } = buildRecordingMetrics();
    const service = new ProviderSearchService(backend, buildSponsoredClient().client, metrics);
    await service.upsertProvider({ providerIdPath: 'prov_abc', document: buildDoc() });
    await service.upsertProvider({ providerIdPath: 'prov_abc', document: buildDoc() });
    await service.upsertProvider({
      providerIdPath: 'prov_xyz',
      document: buildDoc({ providerId: 'prov_abc' }),
    });
    expect(upserts).toEqual(['created', 'unchanged', 'provider_id_mismatch']);
  });

  it('records delete outcomes (deleted then not_found)', async () => {
    await backend.upsertProvider({ document: buildDoc() });
    const { metrics, deletes } = buildRecordingMetrics();
    const service = new ProviderSearchService(backend, buildSponsoredClient().client, metrics);
    await service.deleteProvider({ providerId: 'prov_abc' });
    await service.deleteProvider({ providerId: 'prov_abc' });
    expect(deletes).toEqual(['deleted', 'not_found']);
  });
});
