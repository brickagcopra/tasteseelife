import { describe, expect, it } from 'vitest';

import { PrismaService } from '../../prisma/prisma.service';
import { FakeSlotPrisma } from './__fixtures__/fake-prisma';
import { AD_PLACEMENT_SEED } from './placement-seed-data';
import { seedAdPlacements } from './placement-seed';

function build(): { prisma: FakeSlotPrisma } {
  return { prisma: new FakeSlotPrisma() };
}

describe('seedAdPlacements', () => {
  it('creates all five predefined placements on a first run', async () => {
    const { prisma } = build();
    const report = await seedAdPlacements(prisma as unknown as PrismaService);

    expect(report.created).toHaveLength(AD_PLACEMENT_SEED.length);
    expect(report.updated).toHaveLength(0);
    expect(report.entriesUpserted).toBe(AD_PLACEMENT_SEED.length);
    expect(prisma.placements.map((r) => r['slotCode']).sort()).toEqual(
      AD_PLACEMENT_SEED.map((e) => e.slotCode).sort(),
    );
  });

  it('is idempotent — a second run updates, never re-creates', async () => {
    const { prisma } = build();
    await seedAdPlacements(prisma as unknown as PrismaService);
    const idsAfterFirst = prisma.placements.map((r) => r['id']).sort();

    const report = await seedAdPlacements(prisma as unknown as PrismaService);
    expect(report.created).toHaveLength(0);
    expect(report.updated).toHaveLength(AD_PLACEMENT_SEED.length);
    // No new rows + the existing ids are preserved (so any FK stays valid).
    expect(prisma.placements).toHaveLength(AD_PLACEMENT_SEED.length);
    expect(prisma.placements.map((r) => r['id']).sort()).toEqual(idsAfterFirst);
  });

  it('seeds the search_top_tile slot with the sponsored_listing kind', async () => {
    const { prisma } = build();
    await seedAdPlacements(prisma as unknown as PrismaService);
    const tile = prisma.placements.find((r) => r['slotCode'] === 'search_top_tile');
    expect(tile?.['supportedCreativeKinds']).toEqual(['sponsored_listing']);
  });
});
