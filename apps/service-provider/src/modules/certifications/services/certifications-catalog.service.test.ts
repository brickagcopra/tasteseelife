import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import {
  CertificationsCatalogService,
  type CertificationCatalogRecord,
} from './certifications-catalog.service';

interface FakeRow extends CertificationCatalogRecord {}

class FakePrisma {
  public rows: FakeRow[] = [];

  certification = {
    findMany: vi.fn(
      async (args: {
        where?: { active?: boolean; id?: { in: string[] } };
        orderBy?: ReadonlyArray<{ sortPosition?: 'asc' | 'desc'; code?: 'asc' | 'desc' }>;
      }): Promise<FakeRow[]> => {
        let filtered = [...this.rows];
        const active = args.where?.active;
        if (active !== undefined) {
          filtered = filtered.filter((r) => r.active === active);
        }
        const idIn = args.where?.id?.in;
        if (idIn !== undefined) {
          const wanted = new Set(idIn);
          filtered = filtered.filter((r) => wanted.has(r.id));
        }
        // Mirror Prisma's orderBy: array of single-key objects.
        const orderBy = args.orderBy ?? [];
        filtered.sort((a, b) => {
          for (const clause of orderBy) {
            if (clause.sortPosition !== undefined) {
              const sign = clause.sortPosition === 'asc' ? 1 : -1;
              if (a.sortPosition !== b.sortPosition) {
                return (a.sortPosition - b.sortPosition) * sign;
              }
            }
            if (clause.code !== undefined) {
              const sign = clause.code === 'asc' ? 1 : -1;
              if (a.code !== b.code) {
                return (a.code < b.code ? -1 : 1) * sign;
              }
            }
          }
          return 0;
        });
        return filtered;
      },
    ),
    findUnique: vi.fn(
      async (args: { where: { code?: string; id?: string } }): Promise<FakeRow | null> => {
        if (args.where.code !== undefined) {
          return this.rows.find((r) => r.code === args.where.code) ?? null;
        }
        if (args.where.id !== undefined) {
          return this.rows.find((r) => r.id === args.where.id) ?? null;
        }
        return null;
      },
    ),
  };
}

function buildPrisma(): FakePrisma {
  return new FakePrisma();
}

function mkRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'cert_x',
    code: 'x',
    name: 'X',
    description: 'desc',
    issuer: 'Taste & See Cooking Academy',
    defaultValidityMonths: 24,
    sortPosition: 0,
    active: true,
    createdAt: new Date('2026-05-11T00:00:00.000Z'),
    updatedAt: new Date('2026-05-11T00:00:00.000Z'),
    ...overrides,
  };
}

describe('CertificationsCatalogService.listActive', () => {
  it('returns active rows ordered by sortPosition then code', async () => {
    const prisma = buildPrisma();
    prisma.rows = [
      mkRow({ id: 'cert_b', code: 'b', sortPosition: 1 }),
      mkRow({ id: 'cert_a1', code: 'a1', sortPosition: 0 }),
      mkRow({ id: 'cert_a2', code: 'a2', sortPosition: 0 }),
      mkRow({ id: 'cert_z', code: 'z', sortPosition: 0, active: false }),
    ];
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    const list = await svc.listActive();

    expect(list.map((r) => r.code)).toEqual(['a1', 'a2', 'b']);
  });

  it('returns an empty list when the catalog has no active rows', async () => {
    const prisma = buildPrisma();
    prisma.rows = [mkRow({ active: false })];
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    expect(await svc.listActive()).toEqual([]);
  });
});

describe('CertificationsCatalogService.findByCode', () => {
  it('returns the row when active', async () => {
    const prisma = buildPrisma();
    prisma.rows = [mkRow({ id: 'cert_ccc', code: 'ccc' })];
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    const found = await svc.findByCode('ccc');
    expect(found?.id).toBe('cert_ccc');
  });

  it('returns null for an empty code', async () => {
    const prisma = buildPrisma();
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    expect(await svc.findByCode('')).toBeNull();
    expect(prisma.certification.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when no row exists', async () => {
    const prisma = buildPrisma();
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    expect(await svc.findByCode('nope')).toBeNull();
  });

  it('returns null when the row exists but is inactive', async () => {
    const prisma = buildPrisma();
    prisma.rows = [mkRow({ code: 'old', active: false })];
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    expect(await svc.findByCode('old')).toBeNull();
  });
});

describe('CertificationsCatalogService.findById', () => {
  it('returns the row including inactive rows (historical issuance support)', async () => {
    const prisma = buildPrisma();
    prisma.rows = [mkRow({ id: 'cert_retired', active: false })];
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    const found = await svc.findById('cert_retired');
    expect(found?.id).toBe('cert_retired');
    expect(found?.active).toBe(false);
  });

  it('returns null for an empty id', async () => {
    const prisma = buildPrisma();
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    expect(await svc.findById('')).toBeNull();
    expect(prisma.certification.findUnique).not.toHaveBeenCalled();
  });
});

describe('CertificationsCatalogService.findManyByIds', () => {
  it('returns a map keyed by id', async () => {
    const prisma = buildPrisma();
    prisma.rows = [
      mkRow({ id: 'cert_1', code: 'a' }),
      mkRow({ id: 'cert_2', code: 'b' }),
      mkRow({ id: 'cert_3', code: 'c' }),
    ];
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    const map = await svc.findManyByIds(['cert_1', 'cert_3']);

    expect(map.size).toBe(2);
    expect(map.get('cert_1')?.code).toBe('a');
    expect(map.get('cert_3')?.code).toBe('c');
    expect(map.get('cert_2')).toBeUndefined();
  });

  it('short-circuits when ids is empty', async () => {
    const prisma = buildPrisma();
    const svc = new CertificationsCatalogService(prisma as unknown as PrismaService);

    const map = await svc.findManyByIds([]);
    expect(map.size).toBe(0);
    expect(prisma.certification.findMany).not.toHaveBeenCalled();
  });
});
