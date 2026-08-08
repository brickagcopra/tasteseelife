import { describe, expect, it } from 'vitest';

import {
  DeleteFeaturedPlacementResponseSchema,
  FEATURED_PLACEMENT_BOOST_DEFAULT,
  FEATURED_PLACEMENT_BOOST_MAX,
  FEATURED_PLACEMENT_BOOST_MIN,
  FEATURED_PLACEMENT_LIST_LIMIT_DEFAULT,
  FEATURED_PLACEMENT_LIST_LIMIT_MAX,
  FeaturedPlacementRecordSchema,
  FeaturedPlacementsListResponseSchema,
  ListFeaturedPlacementsQuerySchema,
  ScheduleFeaturedPlacementRequestSchema,
  ScheduleFeaturedPlacementResponseSchema,
} from '../http/featured-placement.schema';

const T0 = '2026-06-01T09:00:00.000Z';
const T1 = '2026-06-08T09:00:00.000Z';

function buildRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fp_abc',
    providerId: 'prov_abc',
    regionCode: null,
    tier: null,
    boostMultiplier: 2,
    startsAt: T0,
    endsAt: T1,
    note: null,
    createdByUserId: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('FeaturedPlacementRecordSchema', () => {
  it('parses a full record with null scopes', () => {
    const parsed = FeaturedPlacementRecordSchema.parse(buildRecord());
    expect(parsed.regionCode).toBeNull();
    expect(parsed.tier).toBeNull();
    expect(parsed.boostMultiplier).toBe(2);
  });

  it('accepts a region + tier scope', () => {
    const parsed = FeaturedPlacementRecordSchema.parse(
      buildRecord({ regionCode: 'nyc', tier: 'elite', createdByUserId: 'user_admin' }),
    );
    expect(parsed.regionCode).toBe('nyc');
    expect(parsed.tier).toBe('elite');
    expect(parsed.createdByUserId).toBe('user_admin');
  });

  it('rejects an unknown tier', () => {
    expect(() => FeaturedPlacementRecordSchema.parse(buildRecord({ tier: 'platinum' }))).toThrow();
  });

  it('rejects a region code with invalid characters', () => {
    expect(() =>
      FeaturedPlacementRecordSchema.parse(buildRecord({ regionCode: 'New York' })),
    ).toThrow();
  });

  it('rejects a boost below the floor', () => {
    expect(() =>
      FeaturedPlacementRecordSchema.parse(
        buildRecord({ boostMultiplier: FEATURED_PLACEMENT_BOOST_MIN - 0.5 }),
      ),
    ).toThrow();
  });

  it('rejects a boost above the ceiling', () => {
    expect(() =>
      FeaturedPlacementRecordSchema.parse(
        buildRecord({ boostMultiplier: FEATURED_PLACEMENT_BOOST_MAX + 1 }),
      ),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => FeaturedPlacementRecordSchema.parse(buildRecord({ extra: true }))).toThrow();
  });
});

describe('ScheduleFeaturedPlacementRequestSchema', () => {
  it('applies the default boost when omitted', () => {
    const parsed = ScheduleFeaturedPlacementRequestSchema.parse({
      providerId: 'prov_abc',
      startsAt: T0,
      endsAt: T1,
    });
    expect(parsed.boostMultiplier).toBe(FEATURED_PLACEMENT_BOOST_DEFAULT);
    expect(parsed.regionCode).toBeUndefined();
    expect(parsed.tier).toBeUndefined();
  });

  it('accepts optional scopes + note + attribution', () => {
    const parsed = ScheduleFeaturedPlacementRequestSchema.parse({
      providerId: 'prov_abc',
      regionCode: 'bay_area',
      tier: 'certified',
      boostMultiplier: 3,
      startsAt: T0,
      endsAt: T1,
      note: 'Spring launch promo',
      createdByUserId: 'user_admin',
    });
    expect(parsed.regionCode).toBe('bay_area');
    expect(parsed.tier).toBe('certified');
    expect(parsed.note).toBe('Spring launch promo');
  });

  it('rejects a window where startsAt is not before endsAt', () => {
    const result = ScheduleFeaturedPlacementRequestSchema.safeParse({
      providerId: 'prov_abc',
      startsAt: T1,
      endsAt: T0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('endsAt'))).toBe(true);
    }
  });

  it('rejects an equal-instant window', () => {
    expect(
      ScheduleFeaturedPlacementRequestSchema.safeParse({
        providerId: 'prov_abc',
        startsAt: T0,
        endsAt: T0,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      ScheduleFeaturedPlacementRequestSchema.safeParse({
        providerId: 'prov_abc',
        startsAt: T0,
        endsAt: T1,
        smuggled: 1,
      }).success,
    ).toBe(false);
  });
});

describe('ScheduleFeaturedPlacementResponseSchema', () => {
  it('wraps the created record', () => {
    const parsed = ScheduleFeaturedPlacementResponseSchema.parse({ placement: buildRecord() });
    expect(parsed.placement.id).toBe('fp_abc');
  });
});

describe('ListFeaturedPlacementsQuerySchema', () => {
  it('defaults the limit and leaves filters optional', () => {
    const parsed = ListFeaturedPlacementsQuerySchema.parse({});
    expect(parsed.limit).toBe(FEATURED_PLACEMENT_LIST_LIMIT_DEFAULT);
    expect(parsed.providerId).toBeUndefined();
    expect(parsed.activeOnly).toBeUndefined();
  });

  it('coerces a numeric limit string and the activeOnly flag', () => {
    const parsed = ListFeaturedPlacementsQuerySchema.parse({
      providerId: 'prov_abc',
      activeOnly: 'true',
      limit: '25',
    });
    expect(parsed.limit).toBe(25);
    expect(parsed.activeOnly).toBe(true);
  });

  it('treats activeOnly=false as false', () => {
    const parsed = ListFeaturedPlacementsQuerySchema.parse({ activeOnly: 'false' });
    expect(parsed.activeOnly).toBe(false);
  });

  it('rejects a limit over the cap', () => {
    expect(
      ListFeaturedPlacementsQuerySchema.safeParse({
        limit: String(FEATURED_PLACEMENT_LIST_LIMIT_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe('FeaturedPlacementsListResponseSchema', () => {
  it('parses an array of placements', () => {
    const parsed = FeaturedPlacementsListResponseSchema.parse({
      placements: [buildRecord(), buildRecord({ id: 'fp_def' })],
    });
    expect(parsed.placements).toHaveLength(2);
  });
});

describe('DeleteFeaturedPlacementResponseSchema', () => {
  it('parses a deleted outcome', () => {
    const parsed = DeleteFeaturedPlacementResponseSchema.parse({
      outcome: 'deleted',
      placementId: 'fp_abc',
    });
    expect(parsed.outcome).toBe('deleted');
  });

  it('rejects an unknown outcome', () => {
    expect(
      DeleteFeaturedPlacementResponseSchema.safeParse({
        outcome: 'archived',
        placementId: 'fp_abc',
      }).success,
    ).toBe(false);
  });
});
