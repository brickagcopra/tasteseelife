import { beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { FeaturedPlacementsService } from './featured-placements.service';

interface FakeRow {
  id: string;
  providerId: string;
  regionCode: string | null;
  tier: string | null;
  boostMultiplier: number;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FindManyWhere {
  providerId?: string;
  startsAt?: { lte: Date };
  endsAt?: { gt: Date };
}

class FakePrisma {
  private nextId = 1;
  rows: FakeRow[] = [];
  findManyCalls = 0;
  throwOnFindMany = false;

  featuredPlacement = {
    findMany: async (opts: {
      where?: FindManyWhere;
      orderBy?: { startsAt: 'asc' | 'desc' };
      take?: number;
      select?: Record<string, true>;
    }): Promise<FakeRow[]> => {
      this.findManyCalls += 1;
      if (this.throwOnFindMany) throw new Error('boom');
      let result = this.rows.filter((row) => {
        const where = opts.where ?? {};
        if (where.providerId !== undefined && row.providerId !== where.providerId) return false;
        if (
          where.startsAt?.lte !== undefined &&
          row.startsAt.getTime() > where.startsAt.lte.getTime()
        )
          return false;
        if (where.endsAt?.gt !== undefined && row.endsAt.getTime() <= where.endsAt.gt.getTime())
          return false;
        return true;
      });
      if (opts.orderBy?.startsAt === 'desc') {
        result = [...result].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
      }
      if (opts.take !== undefined) result = result.slice(0, opts.take);
      return Promise.resolve(result);
    },
    create: async (opts: {
      data: Omit<FakeRow, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<FakeRow> => {
      const now = new Date('2026-05-25T12:00:00.000Z');
      const created: FakeRow = {
        id: `fp_${this.nextId++}`,
        providerId: opts.data.providerId,
        regionCode: opts.data.regionCode ?? null,
        tier: opts.data.tier ?? null,
        boostMultiplier: opts.data.boostMultiplier,
        startsAt: opts.data.startsAt,
        endsAt: opts.data.endsAt,
        note: opts.data.note ?? null,
        createdByUserId: opts.data.createdByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(created);
      return Promise.resolve(created);
    },
    findUnique: async (opts: {
      where: { id: string };
      select?: Record<string, true>;
    }): Promise<{ id: string } | null> => {
      const row = this.rows.find((r) => r.id === opts.where.id);
      return Promise.resolve(row === undefined ? null : { id: row.id });
    },
    delete: async (opts: { where: { id: string } }): Promise<FakeRow> => {
      const idx = this.rows.findIndex((r) => r.id === opts.where.id);
      if (idx < 0) throw new Error('not found');
      const [row] = this.rows.splice(idx, 1);
      return Promise.resolve(row as FakeRow);
    },
  };
}

function makeSvc(prisma: FakePrisma): FeaturedPlacementsService {
  return new FeaturedPlacementsService(prisma as unknown as PrismaService);
}

const HOUR_MS = 3_600_000;

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  const now = Date.now();
  return {
    id: overrides.id ?? 'fp_seed',
    providerId: overrides.providerId ?? 'prov_abc',
    regionCode: overrides.regionCode ?? null,
    tier: overrides.tier ?? null,
    boostMultiplier: overrides.boostMultiplier ?? 2,
    startsAt: overrides.startsAt ?? new Date(now - HOUR_MS),
    endsAt: overrides.endsAt ?? new Date(now + HOUR_MS),
    note: overrides.note ?? null,
    createdByUserId: overrides.createdByUserId ?? null,
    createdAt: overrides.createdAt ?? new Date(now - HOUR_MS),
    updatedAt: overrides.updatedAt ?? new Date(now - HOUR_MS),
  };
}

describe('FeaturedPlacementsService.resolveActivePlacements', () => {
  let prisma: FakePrisma;
  let svc: FeaturedPlacementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = makeSvc(prisma);
  });

  it('returns only the placements whose window contains now', async () => {
    const now = Date.now();
    prisma.rows = [
      row({ id: 'active', providerId: 'prov_active' }),
      row({
        id: 'future',
        providerId: 'prov_future',
        startsAt: new Date(now + HOUR_MS),
        endsAt: new Date(now + 2 * HOUR_MS),
      }),
      row({
        id: 'past',
        providerId: 'prov_past',
        startsAt: new Date(now - 2 * HOUR_MS),
        endsAt: new Date(now - HOUR_MS),
      }),
    ];
    const active = await svc.resolveActivePlacements();
    expect(active.map((p) => p.providerId)).toEqual(['prov_active']);
    expect(active[0]?.boostMultiplier).toBe(2);
  });

  it('caches the resolved set + re-reads after invalidate', async () => {
    prisma.rows = [row()];
    await svc.resolveActivePlacements();
    await svc.resolveActivePlacements();
    expect(prisma.findManyCalls).toBe(1);

    svc.invalidate();
    await svc.resolveActivePlacements();
    expect(prisma.findManyCalls).toBe(2);
  });

  it('degrades to an empty set when the DB read fails', async () => {
    prisma.throwOnFindMany = true;
    const active = await svc.resolveActivePlacements();
    expect(active).toEqual([]);
  });
});

describe('FeaturedPlacementsService.list', () => {
  let prisma: FakePrisma;
  let svc: FeaturedPlacementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = makeSvc(prisma);
  });

  it('returns all placements ordered by startsAt desc', async () => {
    const now = Date.now();
    prisma.rows = [
      row({ id: 'older', startsAt: new Date(now - 2 * HOUR_MS) }),
      row({ id: 'newer', startsAt: new Date(now + 2 * HOUR_MS) }),
    ];
    const result = await svc.list({ limit: 50 });
    expect(result.placements.map((p) => p.id)).toEqual(['newer', 'older']);
  });

  it('filters by providerId', async () => {
    prisma.rows = [row({ id: 'a', providerId: 'prov_a' }), row({ id: 'b', providerId: 'prov_b' })];
    const result = await svc.list({ providerId: 'prov_b', limit: 50 });
    expect(result.placements.map((p) => p.id)).toEqual(['b']);
  });

  it('filters to active windows when activeOnly is set', async () => {
    const now = Date.now();
    prisma.rows = [
      row({ id: 'active' }),
      row({
        id: 'expired',
        startsAt: new Date(now - 2 * HOUR_MS),
        endsAt: new Date(now - HOUR_MS),
      }),
    ];
    const result = await svc.list({ activeOnly: true, limit: 50 });
    expect(result.placements.map((p) => p.id)).toEqual(['active']);
  });

  it('maps the row onto the contract record (ISO strings + null scopes)', async () => {
    prisma.rows = [row({ id: 'fp_x', regionCode: 'nyc', tier: 'elite', note: 'promo' })];
    const result = await svc.list({ limit: 50 });
    const placement = result.placements[0];
    expect(placement?.regionCode).toBe('nyc');
    expect(placement?.tier).toBe('elite');
    expect(placement?.note).toBe('promo');
    expect(typeof placement?.startsAt).toBe('string');
    expect(placement?.startsAt).toMatch(/T.*Z$/);
  });
});

describe('FeaturedPlacementsService.schedule', () => {
  let prisma: FakePrisma;
  let svc: FeaturedPlacementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = makeSvc(prisma);
  });

  it('creates a placement + returns the record', async () => {
    const response = await svc.schedule({
      providerId: 'prov_abc',
      boostMultiplier: 3,
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-08T09:00:00.000Z',
    });
    expect(response.placement.providerId).toBe('prov_abc');
    expect(response.placement.boostMultiplier).toBe(3);
    expect(response.placement.regionCode).toBeNull();
    expect(response.placement.tier).toBeNull();
    expect(prisma.rows).toHaveLength(1);
  });

  it('persists optional scopes + note + attribution', async () => {
    const response = await svc.schedule({
      providerId: 'prov_abc',
      regionCode: 'bay_area',
      tier: 'certified',
      boostMultiplier: 2,
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-08T09:00:00.000Z',
      note: 'launch',
      createdByUserId: 'user_admin',
    });
    expect(response.placement.regionCode).toBe('bay_area');
    expect(response.placement.tier).toBe('certified');
    expect(response.placement.createdByUserId).toBe('user_admin');
  });

  it('invalidates the active-placement cache', async () => {
    prisma.rows = [row()];
    await svc.resolveActivePlacements();
    expect(prisma.findManyCalls).toBe(1);
    await svc.schedule({
      providerId: 'prov_new',
      boostMultiplier: 2,
      startsAt: '2026-06-01T09:00:00.000Z',
      endsAt: '2026-06-08T09:00:00.000Z',
    });
    await svc.resolveActivePlacements();
    expect(prisma.findManyCalls).toBe(2);
  });
});

describe('FeaturedPlacementsService.delete', () => {
  let prisma: FakePrisma;
  let svc: FeaturedPlacementsService;

  beforeEach(() => {
    prisma = new FakePrisma();
    svc = makeSvc(prisma);
  });

  it('deletes a known placement', async () => {
    prisma.rows = [row({ id: 'fp_del' })];
    const result = await svc.delete('fp_del');
    expect(result.outcome).toBe('deleted');
    expect(prisma.rows).toHaveLength(0);
  });

  it('returns not_found for an unknown placement (idempotent replay)', async () => {
    const result = await svc.delete('fp_ghost');
    expect(result.outcome).toBe('not_found');
  });

  it('invalidates the active-placement cache on a real delete', async () => {
    prisma.rows = [row({ id: 'fp_del' })];
    await svc.resolveActivePlacements();
    expect(prisma.findManyCalls).toBe(1);
    await svc.delete('fp_del');
    await svc.resolveActivePlacements();
    expect(prisma.findManyCalls).toBe(2);
  });
});
