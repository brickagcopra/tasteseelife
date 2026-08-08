import { describe, expect, it } from 'vitest';
import type { AdTargetingAudience } from '@taste-and-see/contracts';

import type { TargetingService } from '../../targeting/services/targeting.service';
import type { Clock } from '../sponsored-listings.clock';
import type {
  ActiveSponsoredCampaign,
  SponsoredCampaignRepository,
} from '../repositories/sponsored-campaign.repository';
import { SponsoredListingsMetrics } from './sponsored-listings-metrics';
import { SponsoredListingsService } from './sponsored-listings.service';

/**
 * SponsoredListingsService unit suite (TS-218a).
 *
 * Fakes the campaign repository + the targeting evaluator + the clock so the
 * resolve orchestration (candidate-order ordering, per-provider winner
 * selection, targeting filter, dedupe, limit) is deterministic without a
 * database. The targeting *engine* itself is covered in targeting.service.test;
 * here a campaign matches IFF its id is in `matchingCampaignIds`.
 */

const NOW = new Date('2026-06-13T12:00:00.000Z');
const FIXED_CLOCK: Clock = { now: () => NOW };

function campaign(
  overrides: Partial<ActiveSponsoredCampaign> &
    Pick<ActiveSponsoredCampaign, 'campaignId' | 'providerId'>,
): ActiveSponsoredCampaign {
  return {
    creativeId: `${overrides.campaignId}_crea`,
    startAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function buildService(params: {
  active: ActiveSponsoredCampaign[];
  matchingCampaignIds: ReadonlySet<string>;
}): SponsoredListingsService {
  const repo = {
    findActiveSponsoredCampaigns: async () => params.active,
  } as unknown as SponsoredCampaignRepository;
  const targeting = {
    evaluateCampaignTargeting: async (campaignId: string) => ({
      match: params.matchingCampaignIds.has(campaignId),
      ruleCount: 0,
      malformedRuleCount: 0,
    }),
  } as unknown as TargetingService;
  return new SponsoredListingsService(repo, targeting, FIXED_CLOCK, new SponsoredListingsMetrics());
}

const AUDIENCE: AdTargetingAudience = { behaviorCohorts: [] };

describe('SponsoredListingsService.resolve', () => {
  it('returns no listings (but a resolvedAt) for an empty candidate set', async () => {
    const service = buildService({ active: [], matchingCampaignIds: new Set() });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: [],
      limit: 3,
    });
    expect(result.listings).toEqual([]);
    expect(result.slotCode).toBe('search_top_tile');
    expect(result.resolvedAt).toBe(NOW.toISOString());
  });

  it('returns a sponsored listing for a matching candidate', async () => {
    const service = buildService({
      active: [campaign({ campaignId: 'camp_a', providerId: 'prov_a' })],
      matchingCampaignIds: new Set(['camp_a']),
    });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: ['prov_a'],
      limit: 3,
    });
    expect(result.listings).toEqual([
      { providerId: 'prov_a', campaignId: 'camp_a', creativeId: 'camp_a_crea' },
    ]);
  });

  it('excludes a candidate whose campaign does not match the audience targeting', async () => {
    const service = buildService({
      active: [campaign({ campaignId: 'camp_a', providerId: 'prov_a' })],
      matchingCampaignIds: new Set(), // targeting rejects camp_a
    });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: ['prov_a'],
      limit: 3,
    });
    expect(result.listings).toEqual([]);
  });

  it('skips a candidate with no active sponsored campaign', async () => {
    const service = buildService({
      active: [campaign({ campaignId: 'camp_b', providerId: 'prov_b' })],
      matchingCampaignIds: new Set(['camp_b']),
    });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: ['prov_a', 'prov_b'],
      limit: 3,
    });
    expect(result.listings.map((l) => l.providerId)).toEqual(['prov_b']);
  });

  it('orders listings by candidate (relevance) order, not campaign order', async () => {
    const service = buildService({
      active: [
        campaign({ campaignId: 'camp_b', providerId: 'prov_b' }),
        campaign({ campaignId: 'camp_a', providerId: 'prov_a' }),
      ],
      matchingCampaignIds: new Set(['camp_a', 'camp_b']),
    });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: ['prov_a', 'prov_b'],
      limit: 3,
    });
    expect(result.listings.map((l) => l.providerId)).toEqual(['prov_a', 'prov_b']);
  });

  it('respects the slot limit', async () => {
    const service = buildService({
      active: [
        campaign({ campaignId: 'camp_a', providerId: 'prov_a' }),
        campaign({ campaignId: 'camp_b', providerId: 'prov_b' }),
        campaign({ campaignId: 'camp_c', providerId: 'prov_c' }),
      ],
      matchingCampaignIds: new Set(['camp_a', 'camp_b', 'camp_c']),
    });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: ['prov_a', 'prov_b', 'prov_c'],
      limit: 2,
    });
    expect(result.listings.map((l) => l.providerId)).toEqual(['prov_a', 'prov_b']);
  });

  it('dedupes a provider with two active campaigns, picking the most-recently-started winner', async () => {
    const older = new Date('2026-06-01T00:00:00.000Z');
    const newer = new Date('2026-06-10T00:00:00.000Z');
    const service = buildService({
      active: [
        campaign({ campaignId: 'camp_old', providerId: 'prov_a', startAt: older }),
        campaign({ campaignId: 'camp_new', providerId: 'prov_a', startAt: newer }),
      ],
      matchingCampaignIds: new Set(['camp_old', 'camp_new']),
    });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: ['prov_a'],
      limit: 3,
    });
    expect(result.listings).toEqual([
      { providerId: 'prov_a', campaignId: 'camp_new', creativeId: 'camp_new_crea' },
    ]);
  });

  it('falls back to the next campaign when the winner fails targeting', async () => {
    const older = new Date('2026-06-01T00:00:00.000Z');
    const newer = new Date('2026-06-10T00:00:00.000Z');
    const service = buildService({
      active: [
        campaign({ campaignId: 'camp_new', providerId: 'prov_a', startAt: newer }),
        campaign({ campaignId: 'camp_old', providerId: 'prov_a', startAt: older }),
      ],
      matchingCampaignIds: new Set(['camp_old']), // newer winner fails targeting
    });
    const result = await service.resolve({
      slotCode: 'search_top_tile',
      audience: AUDIENCE,
      candidateProviderIds: ['prov_a'],
      limit: 3,
    });
    expect(result.listings).toEqual([
      { providerId: 'prov_a', campaignId: 'camp_old', creativeId: 'camp_old_crea' },
    ]);
  });
});
