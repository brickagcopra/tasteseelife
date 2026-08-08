import { describe, expect, it } from 'vitest';

import { PrismaService } from '../../../prisma/prisma.service';
import { FakeSlotPrisma } from '../__fixtures__/fake-prisma';
import { SlotInventoryRepository } from './slot-inventory.repository';

function build(): { repo: SlotInventoryRepository; prisma: FakeSlotPrisma } {
  const prisma = new FakeSlotPrisma();
  const repo = new SlotInventoryRepository(prisma as unknown as PrismaService);
  return { repo, prisma };
}

describe('SlotInventoryRepository placements', () => {
  it('listPlacements orders by slotCode ascending', async () => {
    const { repo, prisma } = build();
    prisma.seedPlacement('search_top_tile', ['sponsored_listing']);
    prisma.seedPlacement('blog_footer', ['banner']);
    prisma.seedPlacement('home_banner', ['banner']);

    const placements = await repo.listPlacements();
    expect(placements.map((p) => p.slotCode)).toEqual([
      'blog_footer',
      'home_banner',
      'search_top_tile',
    ]);
  });

  it('findPlacement returns the row (with supported kinds) or null; campaignExists reflects presence', async () => {
    const { repo, prisma } = build();
    const placementId = prisma.seedPlacement('home_banner', ['banner']);
    const campaignId = prisma.seedCampaign();

    const found = await repo.findPlacement(placementId);
    expect(found?.id).toBe(placementId);
    expect(found?.supportedCreativeKinds).toEqual(['banner']);
    expect(await repo.findPlacement('plc_missing')).toBeNull();
    expect(await repo.campaignExists(campaignId)).toBe(true);
    expect(await repo.campaignExists('camp_missing')).toBe(false);
  });

  it('findApprovedCreativeKinds returns the distinct kinds of approved creatives only', async () => {
    const { repo, prisma } = build();
    const campaignId = prisma.seedCampaign([
      { kind: 'banner', status: 'approved' },
      { kind: 'banner', status: 'approved' }, // duplicate kind → deduped
      { kind: 'sponsored_content', status: 'approved' },
      { kind: 'partner_card', status: 'pending_review' }, // not approved → excluded
    ]);

    const kinds = await repo.findApprovedCreativeKinds(campaignId);
    expect([...kinds].sort()).toEqual(['banner', 'sponsored_content']);
    expect(await repo.findApprovedCreativeKinds('camp_missing')).toEqual([]);
  });
});

describe('SlotInventoryRepository schedules', () => {
  function seedFixtures(prisma: FakeSlotPrisma): { placementId: string; campaignId: string } {
    return {
      placementId: prisma.seedPlacement('home_banner', ['banner']),
      campaignId: prisma.seedCampaign(),
    };
  }

  it('createSchedule persists the binding', async () => {
    const { repo, prisma } = build();
    const { placementId, campaignId } = seedFixtures(prisma);

    const row = await repo.createSchedule({
      placementId,
      campaignId,
      status: 'scheduled',
      priority: 7,
      startAt: new Date('2026-07-01T00:00:00.000Z'),
      endAt: new Date('2026-07-31T00:00:00.000Z'),
    });

    expect(row.id).toMatch(/^sch_/);
    expect(row.placementId).toBe(placementId);
    expect(row.campaignId).toBe(campaignId);
    expect(row.priority).toBe(7);
    expect(row.endAt).toEqual(new Date('2026-07-31T00:00:00.000Z'));
  });

  it('findSchedule returns the row or null', async () => {
    const { repo, prisma } = build();
    const { placementId, campaignId } = seedFixtures(prisma);
    const created = await repo.createSchedule({
      placementId,
      campaignId,
      status: 'scheduled',
      priority: 0,
      startAt: new Date('2026-07-01T00:00:00.000Z'),
      endAt: null,
    });

    expect(await repo.findSchedule(created.id)).not.toBeNull();
    expect(await repo.findSchedule('sch_nope')).toBeNull();
  });

  it('listSchedules filters by placement / campaign / status, newest first, respects limit', async () => {
    const { repo, prisma } = build();
    const placementA = prisma.seedPlacement('home_banner', ['banner']);
    const placementB = prisma.seedPlacement('blog_footer', ['banner']);
    const campaign = prisma.seedCampaign();
    const start = new Date('2026-07-01T00:00:00.000Z');

    await repo.createSchedule({
      placementId: placementA,
      campaignId: campaign,
      status: 'active',
      priority: 0,
      startAt: start,
      endAt: null,
    });
    await repo.createSchedule({
      placementId: placementB,
      campaignId: campaign,
      status: 'scheduled',
      priority: 0,
      startAt: start,
      endAt: null,
    });
    const last = await repo.createSchedule({
      placementId: placementA,
      campaignId: campaign,
      status: 'active',
      priority: 0,
      startAt: start,
      endAt: null,
    });

    const byPlacement = await repo.listSchedules({ placementId: placementA, limit: 50 });
    expect(byPlacement.map((s) => s.id)).toEqual([last.id, byPlacement[1]?.id]); // newest first
    expect(byPlacement).toHaveLength(2);

    const active = await repo.listSchedules({ status: 'active', limit: 50 });
    expect(active).toHaveLength(2);

    const limited = await repo.listSchedules({ campaignId: campaign, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]?.id).toBe(last.id);
  });

  it('updateSchedule applies a partial patch', async () => {
    const { repo, prisma } = build();
    const { placementId, campaignId } = seedFixtures(prisma);
    const created = await repo.createSchedule({
      placementId,
      campaignId,
      status: 'scheduled',
      priority: 0,
      startAt: new Date('2026-07-01T00:00:00.000Z'),
      endAt: null,
    });

    const updated = await repo.updateSchedule(created.id, { status: 'active', priority: 5 });
    expect(updated.status).toBe('active');
    expect(updated.priority).toBe(5);
  });
});
