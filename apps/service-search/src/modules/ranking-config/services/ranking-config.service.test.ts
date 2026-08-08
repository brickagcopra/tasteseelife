import {
  SEARCH_RANKING_REGION_CODE_GLOBAL,
  SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT,
  SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT,
} from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';

import { RankingConfigService } from './ranking-config.service';

interface FakeRow {
  id: string;
  regionCode: string;
  description: string | null;
  tierWeightBasic: number;
  tierWeightCertified: number;
  tierWeightElite: number;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3020,
    LOG_LEVEL: 'info',
    SERVICE_VERSION: 'dev',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/search_test',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED: true,
    SEARCH_PROVIDER_INDEX_NAME: 'providers_v1',
    SEARCH_TIER_BOOST_BASIC: SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT,
    SEARCH_TIER_BOOST_CERTIFIED: SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT,
    SEARCH_TIER_BOOST_ELITE: SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT,
    SEARCH_GEO_DECAY_SCALE_KM: 40.2336,
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    SEARCH_INDEX_API_KEY: 'k'.repeat(40),
    OUTBOX_PRODUCER_SERVICE: 'service-search',
    OTEL_TRACES_ENABLED: true,
    OTEL_METRICS_ENABLED: true,
    ...overrides,
  };
}

class FakePrisma {
  private nextId = 1;
  rows: FakeRow[] = [];

  searchRankingConfig = {
    findMany: async (opts: { orderBy?: { regionCode: 'asc' | 'desc' } }): Promise<FakeRow[]> => {
      const sorted = [...this.rows];
      if (opts.orderBy?.regionCode === 'asc') {
        sorted.sort((a, b) => a.regionCode.localeCompare(b.regionCode));
      }
      return Promise.resolve(sorted);
    },
    findUnique: async (opts: {
      where: { regionCode: string };
      select?: Record<string, true>;
    }): Promise<FakeRow | null> => {
      const row = this.rows.find((r) => r.regionCode === opts.where.regionCode);
      return Promise.resolve(row ?? null);
    },
    create: async (opts: {
      data: Omit<FakeRow, 'id' | 'createdAt' | 'updatedAt'>;
    }): Promise<FakeRow> => {
      const now = new Date('2026-05-21T12:00:00.000Z');
      const created: FakeRow = {
        id: `rc_${this.nextId++}`,
        regionCode: opts.data.regionCode,
        description: opts.data.description ?? null,
        tierWeightBasic: opts.data.tierWeightBasic,
        tierWeightCertified: opts.data.tierWeightCertified,
        tierWeightElite: opts.data.tierWeightElite,
        updatedByUserId: opts.data.updatedByUserId ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(created);
      return Promise.resolve(created);
    },
    update: async (opts: {
      where: { regionCode: string };
      data: Partial<Omit<FakeRow, 'id' | 'createdAt'>>;
    }): Promise<FakeRow> => {
      const row = this.rows.find((r) => r.regionCode === opts.where.regionCode);
      if (row === undefined) throw new Error('not found');
      Object.assign(row, opts.data, { updatedAt: new Date('2026-05-21T13:00:00.000Z') });
      return Promise.resolve(row);
    },
    delete: async (opts: { where: { regionCode: string } }): Promise<FakeRow> => {
      const idx = this.rows.findIndex((r) => r.regionCode === opts.where.regionCode);
      if (idx < 0) throw new Error('not found');
      const [row] = this.rows.splice(idx, 1);
      return Promise.resolve(row as FakeRow);
    },
  };
}

function makeSvc(prisma: FakePrisma, env: Env = buildEnv()): RankingConfigService {
  return new RankingConfigService(prisma as unknown as PrismaService, env);
}

const globalRow = (): FakeRow => ({
  id: 'rc_seed_global',
  regionCode: SEARCH_RANKING_REGION_CODE_GLOBAL,
  description: 'seeded',
  tierWeightBasic: 1.0,
  tierWeightCertified: 1.2,
  tierWeightElite: 1.5,
  updatedByUserId: null,
  createdAt: new Date('2026-05-21T12:00:00.000Z'),
  updatedAt: new Date('2026-05-21T12:00:00.000Z'),
});

describe('RankingConfigService.resolveWeights', () => {
  let prisma: FakePrisma;
  let svc: RankingConfigService;
  beforeEach(() => {
    prisma = new FakePrisma();
    svc = makeSvc(prisma);
  });

  it('returns the per-region row when present', async () => {
    prisma.rows.push(globalRow());
    prisma.rows.push({
      ...globalRow(),
      id: 'rc_nyc',
      regionCode: 'nyc',
      tierWeightBasic: 1.1,
      tierWeightCertified: 1.4,
      tierWeightElite: 2.0,
    });
    const w = await svc.resolveWeights('nyc');
    expect(w.source).toBe('region');
    expect(w.regionCode).toBe('nyc');
    expect(w.basic).toBe(1.1);
    expect(w.certified).toBe(1.4);
    expect(w.elite).toBe(2.0);
  });

  it('falls back to global when the region row is absent', async () => {
    prisma.rows.push(globalRow());
    const w = await svc.resolveWeights('nyc');
    expect(w.source).toBe('global');
    expect(w.regionCode).toBe(SEARCH_RANKING_REGION_CODE_GLOBAL);
    expect(w.basic).toBe(1.0);
    expect(w.certified).toBe(1.2);
    expect(w.elite).toBe(1.5);
  });

  it('falls back to env defaults when no row exists at all', async () => {
    const w = await svc.resolveWeights('nyc');
    expect(w.source).toBe('env');
    expect(w.basic).toBe(SEARCH_RANKING_TIER_WEIGHT_BASIC_DEFAULT);
    expect(w.certified).toBe(SEARCH_RANKING_TIER_WEIGHT_CERTIFIED_DEFAULT);
    expect(w.elite).toBe(SEARCH_RANKING_TIER_WEIGHT_ELITE_DEFAULT);
  });

  it('falls back to env defaults when the DB read throws', async () => {
    prisma.searchRankingConfig.findUnique = (): Promise<never> =>
      Promise.reject(new Error('db unreachable'));
    const w = await svc.resolveWeights('nyc');
    expect(w.source).toBe('env');
  });

  it('caches the resolved weights for the TTL window', async () => {
    prisma.rows.push(globalRow());
    const w1 = await svc.resolveWeights('nyc');

    // Mutate the underlying row — without cache invalidation, the next
    // call should still see the cached value.
    prisma.rows[0]!.tierWeightElite = 9.0;
    const w2 = await svc.resolveWeights('nyc');
    expect(w2.elite).toBe(w1.elite);
  });

  it('invalidate() drops the cache so the next call reads fresh', async () => {
    prisma.rows.push(globalRow());
    const w1 = await svc.resolveWeights('nyc');
    prisma.rows[0]!.tierWeightElite = 9.0;
    svc.invalidate(SEARCH_RANKING_REGION_CODE_GLOBAL);
    const w2 = await svc.resolveWeights('nyc');
    expect(w2.elite).not.toBe(w1.elite);
    expect(w2.elite).toBe(9.0);
  });

  it('defaults to the global region code when none supplied', async () => {
    prisma.rows.push(globalRow());
    const w = await svc.resolveWeights();
    expect(w.regionCode).toBe(SEARCH_RANKING_REGION_CODE_GLOBAL);
  });

  it('carries the env-sourced geoDecayScaleKm on every resolution path (TS-210)', async () => {
    const tightSvc = makeSvc(new FakePrisma(), buildEnv({ SEARCH_GEO_DECAY_SCALE_KM: 12.5 }));
    // env-fallback path (no rows)
    expect((await tightSvc.resolveWeights('nyc')).geoDecayScaleKm).toBe(12.5);

    // global-fallback + per-region paths read the same env value
    const rowPrisma = new FakePrisma();
    rowPrisma.rows.push(globalRow());
    rowPrisma.rows.push({ ...globalRow(), id: 'rc_nyc', regionCode: 'nyc' });
    const rowSvc = makeSvc(rowPrisma, buildEnv({ SEARCH_GEO_DECAY_SCALE_KM: 12.5 }));
    expect((await rowSvc.resolveWeights('nyc')).geoDecayScaleKm).toBe(12.5);
    expect((await rowSvc.resolveWeights('unmapped')).geoDecayScaleKm).toBe(12.5);
  });
});

describe('RankingConfigService.list / .get', () => {
  it('list returns rows sorted by regionCode', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push({ ...globalRow(), id: 'rc_nyc', regionCode: 'nyc' });
    prisma.rows.push(globalRow());
    prisma.rows.push({ ...globalRow(), id: 'rc_bay', regionCode: 'bay_area' });
    const svc = makeSvc(prisma);
    const response = await svc.list();
    expect(response.configs.map((c) => c.regionCode)).toEqual([
      'bay_area',
      SEARCH_RANKING_REGION_CODE_GLOBAL,
      'nyc',
    ]);
  });

  it('get returns null for an unknown region', async () => {
    const svc = makeSvc(new FakePrisma());
    expect(await svc.get('nope')).toBeNull();
  });

  it('get returns the row for a known region', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push(globalRow());
    const svc = makeSvc(prisma);
    const row = await svc.get(SEARCH_RANKING_REGION_CODE_GLOBAL);
    expect(row?.regionCode).toBe(SEARCH_RANKING_REGION_CODE_GLOBAL);
    expect(row?.tierWeightElite).toBe(1.5);
  });
});

describe('RankingConfigService.upsert', () => {
  it('creates a new row on first write', async () => {
    const prisma = new FakePrisma();
    const svc = makeSvc(prisma);
    const result = await svc.upsert('nyc', {
      tierWeightBasic: 1.1,
      tierWeightCertified: 1.3,
      tierWeightElite: 1.7,
      description: 'NYC override',
      updatedByUserId: 'user_admin',
    });
    expect(result.outcome).toBe('created');
    expect(result.config.regionCode).toBe('nyc');
    expect(result.config.tierWeightElite).toBe(1.7);
    expect(result.config.description).toBe('NYC override');
    expect(result.config.updatedByUserId).toBe('user_admin');
  });

  it('updates when weights change', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push(globalRow());
    const svc = makeSvc(prisma);
    const result = await svc.upsert(SEARCH_RANKING_REGION_CODE_GLOBAL, {
      tierWeightBasic: 1.0,
      tierWeightCertified: 1.3,
      tierWeightElite: 1.5,
    });
    expect(result.outcome).toBe('updated');
    expect(result.config.tierWeightCertified).toBe(1.3);
  });

  it('returns unchanged on a byte-equal replay', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push(globalRow());
    const svc = makeSvc(prisma);
    const result = await svc.upsert(SEARCH_RANKING_REGION_CODE_GLOBAL, {
      tierWeightBasic: 1.0,
      tierWeightCertified: 1.2,
      tierWeightElite: 1.5,
      description: 'seeded',
    });
    expect(result.outcome).toBe('unchanged');
  });

  it('invalidates the cache on a successful write', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push(globalRow());
    const svc = makeSvc(prisma);
    const w1 = await svc.resolveWeights(SEARCH_RANKING_REGION_CODE_GLOBAL);
    await svc.upsert(SEARCH_RANKING_REGION_CODE_GLOBAL, {
      tierWeightBasic: 1.0,
      tierWeightCertified: 1.2,
      tierWeightElite: 2.5,
    });
    const w2 = await svc.resolveWeights(SEARCH_RANKING_REGION_CODE_GLOBAL);
    expect(w1.elite).toBe(1.5);
    expect(w2.elite).toBe(2.5);
  });
});

describe('RankingConfigService.delete', () => {
  it('deletes a per-region row', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push(globalRow());
    prisma.rows.push({ ...globalRow(), id: 'rc_nyc', regionCode: 'nyc' });
    const svc = makeSvc(prisma);
    const result = await svc.delete('nyc');
    expect(result.outcome).toBe('deleted');
    expect(prisma.rows).toHaveLength(1);
  });

  it('returns not_found for an unknown region', async () => {
    const svc = makeSvc(new FakePrisma());
    const result = await svc.delete('nyc');
    expect(result.outcome).toBe('not_found');
  });

  it('refuses to delete the global row', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push(globalRow());
    const svc = makeSvc(prisma);
    const result = await svc.delete(SEARCH_RANKING_REGION_CODE_GLOBAL);
    expect(result.outcome).toBe('global_protected');
    expect(prisma.rows).toHaveLength(1);
  });

  it('invalidates the cache on a successful delete', async () => {
    const prisma = new FakePrisma();
    prisma.rows.push(globalRow());
    prisma.rows.push({
      ...globalRow(),
      id: 'rc_nyc',
      regionCode: 'nyc',
      tierWeightElite: 2.5,
    });
    const svc = makeSvc(prisma);
    const w1 = await svc.resolveWeights('nyc');
    expect(w1.source).toBe('region');
    await svc.delete('nyc');
    const w2 = await svc.resolveWeights('nyc');
    expect(w2.source).toBe('global');
  });
});
