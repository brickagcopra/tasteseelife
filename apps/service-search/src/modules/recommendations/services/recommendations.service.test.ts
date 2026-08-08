import type { RecommendProvidersRequest, RecommendedProvider } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { SearchBackend } from '../../providers/services/search-backend';

import { RecommendationsService } from './recommendations.service';

function buildRecommendation(): RecommendedProvider {
  return {
    document: {
      providerId: 'prov_abc',
      userId: 'user_abc',
      displayName: 'Chef Rosa',
      headline: null,
      bio: null,
      tier: 'certified',
      status: 'active',
      languages: ['es'],
      specialties: ['dementia_sensitive'],
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
      sourceUpdatedAt: '2026-06-01T09:00:00.000Z',
    },
    score: 9.5,
    signals: [
      { kind: 'language', matchedValues: ['es'], contribution: 3 },
      { kind: 'rating', matchedValues: [], contribution: 0.96 },
    ],
  };
}

function makeBackend(overrides: Partial<SearchBackend> = {}): {
  backend: SearchBackend;
  recommendProviders: ReturnType<typeof vi.fn>;
  isLiveMode: ReturnType<typeof vi.fn>;
} {
  const recommendProviders = vi
    .fn()
    .mockResolvedValue({ recommendations: [buildRecommendation()] });
  const isLiveMode = vi.fn().mockReturnValue(false);
  const backend = {
    recommendProviders,
    isLiveMode,
    ping: vi.fn(),
    upsertProvider: vi.fn(),
    deleteProvider: vi.fn(),
    searchProviders: vi.fn(),
    ...overrides,
  } as unknown as SearchBackend;
  return { backend, recommendProviders, isLiveMode };
}

const sampleRequest: RecommendProvidersRequest = {
  profile: {
    languages: ['es'],
    dietaryTags: [],
    cuisinePreferences: ['italian'],
    dementiaSensitive: true,
  },
  limit: 10,
};

describe('RecommendationsService.recommend', () => {
  it('delegates to the backend and shapes the response with liveMode', async () => {
    const { backend, recommendProviders } = makeBackend();
    const service = new RecommendationsService(backend);

    const response = await service.recommend(sampleRequest);

    expect(recommendProviders).toHaveBeenCalledWith({ request: sampleRequest });
    expect(response.liveMode).toBe(false);
    expect(response.recommendations).toHaveLength(1);
    expect(response.recommendations[0]?.document.providerId).toBe('prov_abc');
    expect(response.recommendations[0]?.signals[0]?.kind).toBe('language');
  });

  it('reports liveMode from the backend', async () => {
    const { backend } = makeBackend({ isLiveMode: vi.fn().mockReturnValue(true) });
    const service = new RecommendationsService(backend);
    const response = await service.recommend(sampleRequest);
    expect(response.liveMode).toBe(true);
  });

  it('returns an empty list when the backend has no matches', async () => {
    const { backend } = makeBackend({
      recommendProviders: vi.fn().mockResolvedValue({ recommendations: [] }),
    });
    const service = new RecommendationsService(backend);
    const response = await service.recommend(sampleRequest);
    expect(response.recommendations).toEqual([]);
  });
});
