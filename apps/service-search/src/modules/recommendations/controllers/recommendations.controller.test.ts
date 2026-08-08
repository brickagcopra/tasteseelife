import type { RecommendProvidersRequest } from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { RecommendationsService } from '../services/recommendations.service';

import { RecommendationsController } from './recommendations.controller';

/**
 * Minimal in-memory `TenantContextStore` honoring the `run(frame, fn)` +
 * `current()` surface that `runWithoutTenantContext` uses. Mirrors the
 * featured-placements / ranking-config controller tests.
 */
function makeStore(): TenantContextStore & { current: () => unknown } {
  let current: unknown = null;
  return {
    run<T>(frame: unknown, fn: () => T): T {
      const prev = current;
      current = frame;
      try {
        return fn();
      } finally {
        current = prev;
      }
    },
    current(): unknown {
      return current;
    },
  } as unknown as TenantContextStore & { current: () => unknown };
}

class FakeService {
  recommend = vi.fn();
}

function makeController(
  service: FakeService,
  store: ReturnType<typeof makeStore> = makeStore(),
): RecommendationsController {
  return new RecommendationsController(
    service as unknown as RecommendationsService,
    store as unknown as TenantContextStore,
  );
}

void TENANT_CONTEXT_STORE_TOKEN;

const sampleRequest: RecommendProvidersRequest = {
  profile: {
    languages: ['es'],
    dietaryTags: ['kosher'],
    cuisinePreferences: ['italian'],
    dementiaSensitive: true,
  },
  limit: 10,
};

const sampleResponse = {
  recommendations: [
    {
      document: {
        providerId: 'prov_abc',
        userId: 'user_abc',
        displayName: 'Chef Rosa',
        headline: null,
        bio: null,
        tier: 'certified' as const,
        status: 'active' as const,
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
      signals: [{ kind: 'language' as const, matchedValues: ['es'], contribution: 3 }],
    },
  ],
  liveMode: false,
};

describe('RecommendationsController.recommend', () => {
  it('returns the service recommendation response', async () => {
    const svc = new FakeService();
    svc.recommend.mockResolvedValue(sampleResponse);
    const controller = makeController(svc);
    const response = await controller.recommend(sampleRequest);
    expect(response).toEqual(sampleResponse);
    expect(svc.recommend).toHaveBeenCalledWith(sampleRequest);
  });

  it('wraps the call in an exempt tenant frame', async () => {
    const svc = new FakeService();
    const store = makeStore();
    svc.recommend.mockImplementation(async () => {
      expect(store.current()).toEqual({
        kind: 'exempt',
        reason: 'internal-search-recommendations',
      });
      return sampleResponse;
    });
    await makeController(svc, store).recommend(sampleRequest);
    expect(svc.recommend).toHaveBeenCalledTimes(1);
  });
});
