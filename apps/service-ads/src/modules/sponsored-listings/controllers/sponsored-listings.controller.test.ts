import { describe, expect, it, vi } from 'vitest';
import type {
  ResolveSponsoredListingsRequest,
  ResolveSponsoredListingsResponse,
} from '@taste-and-see/contracts';

import type { SponsoredListingsService } from '../services/sponsored-listings.service';
import { SponsoredListingsController } from './sponsored-listings.controller';

/**
 * SponsoredListingsController unit suite (TS-218a).
 *
 * The shared-secret guard + the Zod request validation are framework-boundary
 * concerns covered by the guard test + the contracts schema test; here we just
 * prove the controller forwards the validated body to the service and returns
 * its result.
 */

describe('SponsoredListingsController.resolve', () => {
  it('forwards the validated request fields to the service and returns its response', async () => {
    const response: ResolveSponsoredListingsResponse = {
      slotCode: 'search_top_tile',
      listings: [{ providerId: 'prov_a', campaignId: 'camp_a', creativeId: 'crea_a' }],
      resolvedAt: '2026-06-13T12:00:00.000Z',
    };
    const resolve = vi.fn(async () => response);
    const service = { resolve } as unknown as SponsoredListingsService;
    const controller = new SponsoredListingsController(service);

    const body: ResolveSponsoredListingsRequest = {
      slotCode: 'search_top_tile',
      audience: { geography: 'NY-Manhattan', behaviorCohorts: [] },
      candidateProviderIds: ['prov_a', 'prov_b'],
      limit: 3,
    };

    const result = await controller.resolve(body);

    expect(result).toBe(response);
    expect(resolve).toHaveBeenCalledWith({
      slotCode: 'search_top_tile',
      audience: { geography: 'NY-Manhattan', behaviorCohorts: [] },
      candidateProviderIds: ['prov_a', 'prov_b'],
      limit: 3,
    });
  });
});
