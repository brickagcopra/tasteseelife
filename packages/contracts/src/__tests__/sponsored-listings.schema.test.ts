import { describe, expect, it } from 'vitest';

import {
  ResolveSponsoredListingsRequestSchema,
  ResolveSponsoredListingsResponseSchema,
  SPONSORED_LISTINGS_CANDIDATES_MAX,
  SPONSORED_LISTINGS_ID_MAX_LENGTH,
  SPONSORED_LISTINGS_LIMIT_DEFAULT,
  SPONSORED_LISTINGS_LIMIT_MAX,
  SponsoredListingSchema,
  SponsoredListingSlotCodeSchema,
} from '../http/sponsored-listings.schema';

describe('SponsoredListingSlotCodeSchema', () => {
  it('accepts a slug/code slot token', () => {
    expect(SponsoredListingSlotCodeSchema.parse('search_top_tile')).toBe('search_top_tile');
  });

  it('rejects whitespace / structural characters', () => {
    expect(SponsoredListingSlotCodeSchema.safeParse('search top').success).toBe(false);
    expect(SponsoredListingSlotCodeSchema.safeParse('{"x":1}').success).toBe(false);
    expect(SponsoredListingSlotCodeSchema.safeParse('').success).toBe(false);
  });
});

describe('ResolveSponsoredListingsRequestSchema', () => {
  const base = {
    slotCode: 'search_top_tile',
    audience: { geography: 'NY-Manhattan' },
    candidateProviderIds: ['prov_a', 'prov_b'],
  };

  it('parses a minimal request and defaults limit', () => {
    const parsed = ResolveSponsoredListingsRequestSchema.parse(base);
    expect(parsed.limit).toBe(SPONSORED_LISTINGS_LIMIT_DEFAULT);
    // audience.behaviorCohorts defaults to [] via the shared audience schema.
    expect(parsed.audience.behaviorCohorts).toEqual([]);
  });

  it('accepts an empty candidate set', () => {
    expect(
      ResolveSponsoredListingsRequestSchema.safeParse({ ...base, candidateProviderIds: [] })
        .success,
    ).toBe(true);
  });

  it('rejects more candidates than the cap', () => {
    const tooMany = Array.from(
      { length: SPONSORED_LISTINGS_CANDIDATES_MAX + 1 },
      (_, i) => `p${i}`,
    );
    expect(
      ResolveSponsoredListingsRequestSchema.safeParse({ ...base, candidateProviderIds: tooMany })
        .success,
    ).toBe(false);
  });

  it('rejects a candidate id outside the CUID alphabet', () => {
    expect(
      ResolveSponsoredListingsRequestSchema.safeParse({
        ...base,
        candidateProviderIds: ['prov.bad'],
      }).success,
    ).toBe(false);
  });

  it('rejects a candidate id over the length bound', () => {
    expect(
      ResolveSponsoredListingsRequestSchema.safeParse({
        ...base,
        candidateProviderIds: ['a'.repeat(SPONSORED_LISTINGS_ID_MAX_LENGTH + 1)],
      }).success,
    ).toBe(false);
  });

  it('rejects a limit over the ceiling', () => {
    expect(
      ResolveSponsoredListingsRequestSchema.safeParse({
        ...base,
        limit: SPONSORED_LISTINGS_LIMIT_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects a limit below 1', () => {
    expect(ResolveSponsoredListingsRequestSchema.safeParse({ ...base, limit: 0 }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(ResolveSponsoredListingsRequestSchema.safeParse({ ...base, extra: true }).success).toBe(
      false,
    );
  });

  it('rejects an audience with an unknown dimension (strict)', () => {
    expect(
      ResolveSponsoredListingsRequestSchema.safeParse({
        ...base,
        audience: { age: '70' },
      }).success,
    ).toBe(false);
  });
});

describe('SponsoredListingSchema', () => {
  it('parses a {providerId, campaignId, creativeId} listing', () => {
    const listing = { providerId: 'prov_a', campaignId: 'camp_1', creativeId: 'crea_1' };
    expect(SponsoredListingSchema.parse(listing)).toEqual(listing);
  });

  it('rejects a listing missing the creative', () => {
    expect(
      SponsoredListingSchema.safeParse({ providerId: 'prov_a', campaignId: 'camp_1' }).success,
    ).toBe(false);
  });
});

describe('ResolveSponsoredListingsResponseSchema', () => {
  it('parses a response with listings + an ISO timestamp', () => {
    const response = {
      slotCode: 'search_top_tile',
      listings: [{ providerId: 'prov_a', campaignId: 'camp_1', creativeId: 'crea_1' }],
      resolvedAt: '2026-06-13T12:00:00.000Z',
    };
    expect(ResolveSponsoredListingsResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a non-ISO resolvedAt', () => {
    expect(
      ResolveSponsoredListingsResponseSchema.safeParse({
        slotCode: 'search_top_tile',
        listings: [],
        resolvedAt: 'yesterday',
      }).success,
    ).toBe(false);
  });

  it('rejects more listings than the ceiling', () => {
    const listings = Array.from({ length: SPONSORED_LISTINGS_LIMIT_MAX + 1 }, (_, i) => ({
      providerId: `prov_${i}`,
      campaignId: `camp_${i}`,
      creativeId: `crea_${i}`,
    }));
    expect(
      ResolveSponsoredListingsResponseSchema.safeParse({
        slotCode: 'search_top_tile',
        listings,
        resolvedAt: '2026-06-13T12:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
