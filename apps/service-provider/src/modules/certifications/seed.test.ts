import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { CERTIFICATION_CATALOG } from './seed-catalog';
import { seedCertificationsCatalog } from './seed';

interface FakeCertificationRow {
  id: string;
  code: string;
  name: string;
  description: string;
  issuer: string;
  defaultValidityMonths: number | null;
  sortPosition: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Minimal Prisma stand-in mirroring service-subscription's plan-seed
 * fake. The seed only touches `prisma.certification` +
 * `prisma.$transaction`; both are stubbed here. `$transaction` runs
 * the callback against the same fake — no rollback semantics needed
 * because the unit suite is single-test-scope (rollback fidelity is
 * the Testcontainers integration test's job).
 */
class FakePrisma {
  public rows: FakeCertificationRow[] = [];
  private autoId = 0;

  certification = {
    findUnique: vi.fn(async (args: { where: { code: string }; select: { id: true } }) => {
      const row = this.rows.find((r) => r.code === args.where.code);
      if (row === undefined) return null;
      return { id: row.id };
    }),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      this.autoId += 1;
      const row: FakeCertificationRow = {
        id: `cert_${this.autoId}`,
        code: args.data['code'] as string,
        name: args.data['name'] as string,
        description: args.data['description'] as string,
        issuer: args.data['issuer'] as string,
        defaultValidityMonths:
          (args.data['defaultValidityMonths'] as number | null | undefined) ?? null,
        sortPosition: args.data['sortPosition'] as number,
        active: args.data['active'] as boolean,
        createdAt: new Date('2026-05-11T00:00:00.000Z'),
        updatedAt: new Date('2026-05-11T00:00:00.000Z'),
      };
      this.rows.push(row);
      return row;
    }),
    update: vi.fn(async (args: { where: { code: string }; data: Record<string, unknown> }) => {
      const row = this.rows.find((r) => r.code === args.where.code);
      if (row === undefined) throw new Error('certification row missing in fake');
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        (row as unknown as Record<string, unknown>)[key] = value;
      }
      row.updatedAt = new Date('2026-05-11T01:00:00.000Z');
      return row;
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction = vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    return fn(this);
  });
}

function buildPrisma(): FakePrisma {
  return new FakePrisma();
}

describe('seedCertificationsCatalog', () => {
  it('inserts every Phase-1 certification on an empty database', async () => {
    const prisma = buildPrisma();

    const report = await seedCertificationsCatalog(prisma as unknown as PrismaService);

    expect(report.certificationsUpserted).toBe(CERTIFICATION_CATALOG.length);
    expect(report.created).toHaveLength(CERTIFICATION_CATALOG.length);
    expect(report.updated).toEqual([]);
    expect(prisma.rows).toHaveLength(CERTIFICATION_CATALOG.length);
  });

  it('seeds all four Phase-1 certification codes', async () => {
    const prisma = buildPrisma();
    await seedCertificationsCatalog(prisma as unknown as PrismaService);

    const codes = prisma.rows.map((r) => r.code).sort();
    expect(codes).toEqual(['ccc', 'dementia_sensitive', 'ecc', 'therapeutic_meals']);
  });

  it('writes default validity months from the catalog', async () => {
    const prisma = buildPrisma();
    await seedCertificationsCatalog(prisma as unknown as PrismaService);

    const ccc = prisma.rows.find((r) => r.code === 'ccc');
    expect(ccc?.defaultValidityMonths).toBe(24);

    const therapeutic = prisma.rows.find((r) => r.code === 'therapeutic_meals');
    expect(therapeutic?.defaultValidityMonths).toBe(36);
  });

  it('is idempotent on a second run (no rows created, every row updated)', async () => {
    const prisma = buildPrisma();

    await seedCertificationsCatalog(prisma as unknown as PrismaService);
    const reportSecond = await seedCertificationsCatalog(prisma as unknown as PrismaService);

    expect(reportSecond.created).toEqual([]);
    expect(reportSecond.updated).toHaveLength(CERTIFICATION_CATALOG.length);
    expect(prisma.rows).toHaveLength(CERTIFICATION_CATALOG.length);
  });

  it('preserves row id across reseeds (issuance FK stability)', async () => {
    const prisma = buildPrisma();

    await seedCertificationsCatalog(prisma as unknown as PrismaService);
    const before = new Map(prisma.rows.map((r) => [r.code, r.id]));

    await seedCertificationsCatalog(prisma as unknown as PrismaService);
    const after = new Map(prisma.rows.map((r) => [r.code, r.id]));

    for (const [code, id] of before) {
      expect(after.get(code)).toBe(id);
    }
  });

  it('refreshes mutable columns when the catalog changes', async () => {
    const prisma = buildPrisma();
    await seedCertificationsCatalog(prisma as unknown as PrismaService);

    // Simulate a hand-edit: bump the description on the CCC row.
    const ccc = prisma.rows.find((r) => r.code === 'ccc');
    if (ccc === undefined) throw new Error('ccc row missing after seed');
    ccc.description = 'stale description';

    await seedCertificationsCatalog(prisma as unknown as PrismaService);

    const cccAfter = prisma.rows.find((r) => r.code === 'ccc');
    expect(cccAfter?.description).not.toBe('stale description');
    expect(cccAfter?.description).toContain('Cooking Academy');
  });

  it('runs inside $transaction', async () => {
    const prisma = buildPrisma();
    await seedCertificationsCatalog(prisma as unknown as PrismaService);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
