import { describe, expect, it } from 'vitest';

import {
  AD_CAMPAIGN_BUDGET_MINOR_MAX,
  AD_CAMPAIGN_CREATIVES_MAX,
  AD_CAMPAIGN_STATUS_TRANSITIONS,
  AD_CREATIVE_STATUS_TRANSITIONS,
  AdCampaignStatusSchema,
  AdCreativeKindSchema,
  AdCreativeStatusSchema,
  AdvertiserKindSchema,
  canTransitionAdCampaign,
  canTransitionAdCreative,
  CreateAdCampaignRequestSchema,
  CreateAdCreativeInputSchema,
  CreateAdTargetingRuleInputSchema,
  InitialAdCampaignStatusSchema,
  InitialAdCreativeStatusSchema,
  isAdCampaignTerminal,
  isAdCreativeTerminal,
  ListAdCampaignsQuerySchema,
  UpdateAdCampaignRequestSchema,
  UpdateAdCreativeStatusRequestSchema,
  type AdCampaignStatus,
  type AdCreativeStatus,
} from '../http/ads-campaign.schema';

describe('enum schemas mirror the Prisma enums', () => {
  it('AdvertiserKindSchema', () => {
    for (const v of ['partner', 'provider', 'internal']) {
      expect(AdvertiserKindSchema.parse(v)).toBe(v);
    }
    expect(AdvertiserKindSchema.safeParse('agency').success).toBe(false);
  });

  it('AdCampaignStatusSchema', () => {
    for (const v of ['draft', 'scheduled', 'active', 'paused', 'completed', 'archived']) {
      expect(AdCampaignStatusSchema.parse(v)).toBe(v);
    }
    expect(AdCampaignStatusSchema.safeParse('deleted').success).toBe(false);
  });

  it('AdCreativeKindSchema', () => {
    for (const v of ['banner', 'sponsored_listing', 'sponsored_content', 'partner_card']) {
      expect(AdCreativeKindSchema.parse(v)).toBe(v);
    }
    expect(AdCreativeKindSchema.safeParse('video').success).toBe(false);
  });

  it('AdCreativeStatusSchema', () => {
    for (const v of ['draft', 'pending_review', 'approved', 'rejected', 'archived']) {
      expect(AdCreativeStatusSchema.parse(v)).toBe(v);
    }
  });

  it('InitialAdCampaignStatusSchema is the creatable subset', () => {
    for (const v of ['draft', 'scheduled', 'active']) {
      expect(InitialAdCampaignStatusSchema.parse(v)).toBe(v);
    }
    for (const v of ['paused', 'completed', 'archived']) {
      expect(InitialAdCampaignStatusSchema.safeParse(v).success).toBe(false);
    }
  });

  it('InitialAdCreativeStatusSchema is the creatable subset', () => {
    expect(InitialAdCreativeStatusSchema.parse('draft')).toBe('draft');
    expect(InitialAdCreativeStatusSchema.parse('pending_review')).toBe('pending_review');
    for (const v of ['approved', 'rejected', 'archived']) {
      expect(InitialAdCreativeStatusSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe('campaign status-transition matrix', () => {
  it('honours the declared edges', () => {
    expect(canTransitionAdCampaign('draft', 'scheduled')).toBe(true);
    expect(canTransitionAdCampaign('draft', 'active')).toBe(true);
    expect(canTransitionAdCampaign('active', 'paused')).toBe(true);
    expect(canTransitionAdCampaign('paused', 'active')).toBe(true);
    expect(canTransitionAdCampaign('active', 'completed')).toBe(true);
    expect(canTransitionAdCampaign('completed', 'archived')).toBe(true);
  });

  it('rejects illegal edges', () => {
    expect(canTransitionAdCampaign('draft', 'completed')).toBe(false);
    expect(canTransitionAdCampaign('completed', 'active')).toBe(false);
    expect(canTransitionAdCampaign('archived', 'draft')).toBe(false);
  });

  it('archived is the only terminal campaign status', () => {
    const statuses = Object.keys(AD_CAMPAIGN_STATUS_TRANSITIONS) as AdCampaignStatus[];
    for (const s of statuses) {
      expect(isAdCampaignTerminal(s)).toBe(s === 'archived');
    }
  });
});

describe('creative status-transition matrix', () => {
  it('honours the review lifecycle', () => {
    expect(canTransitionAdCreative('draft', 'pending_review')).toBe(true);
    expect(canTransitionAdCreative('pending_review', 'approved')).toBe(true);
    expect(canTransitionAdCreative('pending_review', 'rejected')).toBe(true);
    expect(canTransitionAdCreative('approved', 'archived')).toBe(true);
    expect(canTransitionAdCreative('rejected', 'draft')).toBe(true);
  });

  it('rejects illegal edges', () => {
    expect(canTransitionAdCreative('draft', 'approved')).toBe(false);
    expect(canTransitionAdCreative('archived', 'draft')).toBe(false);
  });

  it('archived is the only terminal creative status', () => {
    const statuses = Object.keys(AD_CREATIVE_STATUS_TRANSITIONS) as AdCreativeStatus[];
    for (const s of statuses) {
      expect(isAdCreativeTerminal(s)).toBe(s === 'archived');
    }
  });
});

describe('CreateAdCampaignRequestSchema', () => {
  const base = { name: 'Spring upsell', advertiserKind: 'internal' as const };

  it('applies defaults (draft status, USD currency, null advertiserId)', () => {
    const parsed = CreateAdCampaignRequestSchema.parse(base);
    expect(parsed.status).toBe('draft');
    expect(parsed.currency).toBe('USD');
    expect(parsed.advertiserId).toBeNull();
  });

  it('requires advertiserId for a provider campaign', () => {
    const result = CreateAdCampaignRequestSchema.safeParse({
      name: 'Sponsored chef',
      advertiserKind: 'provider',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a provider campaign with an advertiserId', () => {
    const result = CreateAdCampaignRequestSchema.safeParse({
      name: 'Sponsored chef',
      advertiserKind: 'provider',
      advertiserId: 'prov_123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an advertiserId on an internal house ad', () => {
    const result = CreateAdCampaignRequestSchema.safeParse({
      ...base,
      advertiserId: 'prov_123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects endAt at or before startAt', () => {
    const bad = CreateAdCampaignRequestSchema.safeParse({
      ...base,
      startAt: '2026-06-10T00:00:00.000Z',
      endAt: '2026-06-10T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);

    const good = CreateAdCampaignRequestSchema.safeParse({
      ...base,
      startAt: '2026-06-10T00:00:00.000Z',
      endAt: '2026-06-11T00:00:00.000Z',
    });
    expect(good.success).toBe(true);
  });

  it('rejects a budget over the wire cap', () => {
    const result = CreateAdCampaignRequestSchema.safeParse({
      ...base,
      budgetMinor: AD_CAMPAIGN_BUDGET_MINOR_MAX + 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a float budget', () => {
    const result = CreateAdCampaignRequestSchema.safeParse({ ...base, budgetMinor: 500_00.5 });
    expect(result.success).toBe(false);
  });

  it('rejects more creatives than the cap', () => {
    const creative = { kind: 'banner' as const, headline: 'Hi' };
    const result = CreateAdCampaignRequestSchema.safeParse({
      ...base,
      creatives: Array.from({ length: AD_CAMPAIGN_CREATIVES_MAX + 1 }, () => creative),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown field', () => {
    const result = CreateAdCampaignRequestSchema.safeParse({ ...base, foo: 'bar' });
    expect(result.success).toBe(false);
  });
});

describe('CreateAdCreativeInputSchema', () => {
  it('defaults status to draft and assetKeys to empty', () => {
    const parsed = CreateAdCreativeInputSchema.parse({ kind: 'banner', headline: 'Eat well' });
    expect(parsed.status).toBe('draft');
    expect(parsed.assetKeys).toEqual([]);
  });

  it('rejects a non-URL ctaUrl', () => {
    const result = CreateAdCreativeInputSchema.safeParse({
      kind: 'banner',
      headline: 'Eat well',
      ctaUrl: 'not a url',
    });
    expect(result.success).toBe(false);
  });
});

describe('CreateAdTargetingRuleInputSchema', () => {
  it('accepts a well-formed rule', () => {
    const result = CreateAdTargetingRuleInputSchema.safeParse({
      kind: 'geography',
      predicate: { operator: 'any_of', values: ['NY-Manhattan'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty predicate values list', () => {
    const result = CreateAdTargetingRuleInputSchema.safeParse({
      kind: 'geography',
      predicate: { operator: 'any_of', values: [] },
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateAdCampaignRequestSchema', () => {
  it('requires at least one field', () => {
    expect(UpdateAdCampaignRequestSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single status field', () => {
    expect(UpdateAdCampaignRequestSchema.safeParse({ status: 'active' }).success).toBe(true);
  });

  it('accepts null to clear a nullable field', () => {
    expect(UpdateAdCampaignRequestSchema.safeParse({ budgetMinor: null }).success).toBe(true);
    expect(UpdateAdCampaignRequestSchema.safeParse({ endAt: null }).success).toBe(true);
  });

  it('rejects advertiserKind (not editable)', () => {
    expect(UpdateAdCampaignRequestSchema.safeParse({ advertiserKind: 'provider' }).success).toBe(
      false,
    );
  });
});

describe('UpdateAdCreativeStatusRequestSchema', () => {
  it('requires a status', () => {
    expect(UpdateAdCreativeStatusRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateAdCreativeStatusRequestSchema.safeParse({ status: 'approved' }).success).toBe(
      true,
    );
  });
});

describe('ListAdCampaignsQuerySchema', () => {
  it('defaults the limit', () => {
    expect(ListAdCampaignsQuerySchema.parse({}).limit).toBe(50);
  });

  it('coerces a string limit and caps it', () => {
    expect(ListAdCampaignsQuerySchema.parse({ limit: '10' }).limit).toBe(10);
    expect(ListAdCampaignsQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });
});
