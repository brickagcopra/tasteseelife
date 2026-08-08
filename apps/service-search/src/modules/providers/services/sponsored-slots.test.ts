import type {
  ProviderDiscoveryDocument,
  ProviderDiscoveryHit,
  SponsoredListing,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { applySponsoredSlots } from './sponsored-slots';

function buildDoc(providerId: string): ProviderDiscoveryDocument {
  return {
    providerId,
    userId: `user_${providerId}`,
    displayName: `Chef ${providerId}`,
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
    sourceUpdatedAt: '2026-06-13T12:00:00.000Z',
  };
}

function buildHit(
  providerId: string,
  overrides: Partial<ProviderDiscoveryHit> = {},
): ProviderDiscoveryHit {
  return {
    document: buildDoc(providerId),
    score: 1,
    distanceKm: null,
    featured: false,
    sponsored: null,
    ...overrides,
  };
}

function listing(providerId: string, campaignId: string, creativeId: string): SponsoredListing {
  return { providerId, campaignId, creativeId };
}

function ids(hits: readonly ProviderDiscoveryHit[]): string[] {
  return hits.map((hit) => hit.document.providerId);
}

describe('applySponsoredSlots', () => {
  it('is the identity (all sponsored null) when there are no listings', () => {
    const hits = [buildHit('a'), buildHit('b')];
    const result = applySponsoredSlots(hits, []);
    expect(ids(result)).toEqual(['a', 'b']);
    expect(result.every((hit) => hit.sponsored === null)).toBe(true);
  });

  it('promotes a sponsored provider to the top slot + stamps its campaign/creative', () => {
    const hits = [buildHit('a'), buildHit('b'), buildHit('c')];
    const result = applySponsoredSlots(hits, [listing('c', 'camp_c', 'crv_c')]);
    expect(ids(result)).toEqual(['c', 'a', 'b']);
    expect(result[0]?.sponsored).toEqual({ campaignId: 'camp_c', creativeId: 'crv_c' });
    expect(result[1]?.sponsored).toBeNull();
    expect(result[2]?.sponsored).toBeNull();
  });

  it('seats multiple sponsored providers in listing order, organic remainder after', () => {
    const hits = [buildHit('a'), buildHit('b'), buildHit('c'), buildHit('d')];
    const result = applySponsoredSlots(hits, [
      listing('c', 'camp_c', 'crv_c'),
      listing('a', 'camp_a', 'crv_a'),
    ]);
    expect(ids(result)).toEqual(['c', 'a', 'b', 'd']);
    expect(result[0]?.sponsored).toEqual({ campaignId: 'camp_c', creativeId: 'crv_c' });
    expect(result[1]?.sponsored).toEqual({ campaignId: 'camp_a', creativeId: 'crv_a' });
  });

  it('ignores a listing whose provider is not among the hits', () => {
    const hits = [buildHit('a'), buildHit('b')];
    const result = applySponsoredSlots(hits, [listing('ghost', 'camp', 'crv')]);
    expect(ids(result)).toEqual(['a', 'b']);
    expect(result.every((hit) => hit.sponsored === null)).toBe(true);
  });

  it('seats a provider only once even if it appears twice in the listings', () => {
    const hits = [buildHit('a'), buildHit('b')];
    const result = applySponsoredSlots(hits, [
      listing('a', 'camp_1', 'crv_1'),
      listing('a', 'camp_2', 'crv_2'),
    ]);
    expect(ids(result)).toEqual(['a', 'b']);
    expect(result[0]?.sponsored).toEqual({ campaignId: 'camp_1', creativeId: 'crv_1' });
  });

  it('preserves an existing featured flag on a promoted sponsored hit', () => {
    const hits = [buildHit('a'), buildHit('b', { featured: true })];
    const result = applySponsoredSlots(hits, [listing('b', 'camp_b', 'crv_b')]);
    expect(result[0]?.document.providerId).toBe('b');
    expect(result[0]?.featured).toBe(true);
    expect(result[0]?.sponsored).toEqual({ campaignId: 'camp_b', creativeId: 'crv_b' });
  });
});
