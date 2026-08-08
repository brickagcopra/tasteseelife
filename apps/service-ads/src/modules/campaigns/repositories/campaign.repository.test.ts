import { describe, expect, it } from 'vitest';

import { PrismaService } from '../../../prisma/prisma.service';
import { FakeAdsPrisma } from '../services/__fixtures__/fake-prisma';
import { CampaignRepository } from './campaign.repository';

function build(): { repo: CampaignRepository; prisma: FakeAdsPrisma } {
  const prisma = new FakeAdsPrisma();
  const repo = new CampaignRepository(prisma as unknown as PrismaService);
  return { repo, prisma };
}

const CAMPAIGN = {
  name: 'Spring upsell',
  advertiserKind: 'internal' as const,
  advertiserId: null,
  status: 'draft' as const,
  budget: '5000.00',
  currency: 'USD',
  startAt: null,
  endAt: null,
};

describe('CampaignRepository.createAggregate', () => {
  it('creates a campaign with no creatives / rules', async () => {
    const { repo } = build();
    const result = await repo.createAggregate({
      campaign: CAMPAIGN,
      creatives: [],
      targetingRules: [],
    });

    expect(result.campaign.id).toMatch(/^camp_/);
    expect(result.campaign.name).toBe('Spring upsell');
    expect(result.campaign.budget).toBe('5000.00');
    expect(result.creatives).toHaveLength(0);
    expect(result.targetingRules).toHaveLength(0);
  });

  it('creates nested creatives + targeting rules ordered by creation', async () => {
    const { repo } = build();
    const result = await repo.createAggregate({
      campaign: CAMPAIGN,
      creatives: [
        {
          kind: 'banner',
          assetKeys: ['k1'],
          headline: 'First',
          body: null,
          ctaUrl: null,
          status: 'draft',
        },
        {
          kind: 'sponsored_content',
          assetKeys: [],
          headline: 'Second',
          body: 'copy',
          ctaUrl: 'https://example.com',
          status: 'pending_review',
        },
      ],
      targetingRules: [{ kind: 'geography', value: '{"operator":"any_of","values":["NY"]}' }],
    });

    expect(result.creatives.map((c) => c.headline)).toEqual(['First', 'Second']);
    expect(result.creatives[0]?.campaignId).toBe(result.campaign.id);
    expect(result.creatives[0]?.assetKeys).toEqual(['k1']);
    expect(result.targetingRules).toHaveLength(1);
    expect(result.targetingRules[0]?.kind).toBe('geography');
  });
});

describe('CampaignRepository reads', () => {
  it('findDetail returns the campaign + its creatives + rules', async () => {
    const { repo } = build();
    const created = await repo.createAggregate({
      campaign: CAMPAIGN,
      creatives: [
        {
          kind: 'banner',
          assetKeys: [],
          headline: 'Hi',
          body: null,
          ctaUrl: null,
          status: 'draft',
        },
      ],
      targetingRules: [{ kind: 'tier', value: '{"operator":"any_of","values":["tier_3"]}' }],
    });

    const detail = await repo.findDetail(created.campaign.id);
    expect(detail).not.toBeNull();
    expect(detail?.creatives).toHaveLength(1);
    expect(detail?.targetingRules).toHaveLength(1);
  });

  it('findDetail returns null for an unknown id', async () => {
    const { repo } = build();
    expect(await repo.findDetail('camp_nope')).toBeNull();
  });

  it('listCampaigns filters by status + advertiserKind, newest first, respects limit', async () => {
    const { repo } = build();
    await repo.createAggregate({
      campaign: {
        ...CAMPAIGN,
        name: 'A',
        status: 'active',
        advertiserKind: 'provider',
        advertiserId: 'p1',
      },
      creatives: [],
      targetingRules: [],
    });
    await repo.createAggregate({
      campaign: { ...CAMPAIGN, name: 'B', status: 'draft' },
      creatives: [],
      targetingRules: [],
    });
    await repo.createAggregate({
      campaign: {
        ...CAMPAIGN,
        name: 'C',
        status: 'active',
        advertiserKind: 'provider',
        advertiserId: 'p2',
      },
      creatives: [],
      targetingRules: [],
    });

    const active = await repo.listCampaigns({ status: 'active', limit: 50 });
    expect(active.map((c) => c.name)).toEqual(['C', 'A']); // newest first

    const providers = await repo.listCampaigns({ advertiserKind: 'provider', limit: 50 });
    expect(providers).toHaveLength(2);

    const limited = await repo.listCampaigns({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.name).toBe('C');
  });
});

describe('CampaignRepository writes', () => {
  it('updateCampaign applies a partial patch', async () => {
    const { repo } = build();
    const created = await repo.createAggregate({
      campaign: CAMPAIGN,
      creatives: [],
      targetingRules: [],
    });
    const updated = await repo.updateCampaign(created.campaign.id, {
      status: 'active',
      budget: '1000.00',
    });

    expect(updated.status).toBe('active');
    expect(updated.budget).toBe('1000.00');
  });

  it('findCreative scopes to its campaign', async () => {
    const { repo } = build();
    const created = await repo.createAggregate({
      campaign: CAMPAIGN,
      creatives: [
        {
          kind: 'banner',
          assetKeys: [],
          headline: 'Hi',
          body: null,
          ctaUrl: null,
          status: 'draft',
        },
      ],
      targetingRules: [],
    });
    const creativeId = created.creatives[0]!.id;

    expect(await repo.findCreative(created.campaign.id, creativeId)).not.toBeNull();
    expect(await repo.findCreative('camp_other', creativeId)).toBeNull();
  });

  it('updateCreativeStatus sets the new status', async () => {
    const { repo } = build();
    const created = await repo.createAggregate({
      campaign: CAMPAIGN,
      creatives: [
        {
          kind: 'banner',
          assetKeys: [],
          headline: 'Hi',
          body: null,
          ctaUrl: null,
          status: 'draft',
        },
      ],
      targetingRules: [],
    });
    const updated = await repo.updateCreativeStatus(created.creatives[0]!.id, 'pending_review');
    expect(updated.status).toBe('pending_review');
  });
});
