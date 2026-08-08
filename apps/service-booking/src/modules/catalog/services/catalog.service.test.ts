import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { CatalogService } from './catalog.service';

interface FakeRow {
  kind: string;
  name: string;
  description: string;
  baseRateMin: string;
  baseRateMax: string;
  durationMinutes: number;
  currency: string;
  active: boolean;
  requiredProviderTier: 'basic' | 'certified' | 'elite' | null;
  sortPosition: number;
  updatedAt: Date;
}

/**
 * Minimal Prisma stand-in for `CatalogService`. Stores rate columns as
 * the strings Prisma serialises for `Decimal` columns; the service's
 * mapper calls `.toString()` on them (which works for strings), so the
 * minor-unit conversion is exercised exactly as against a real row.
 */
class FakePrisma {
  public rows: FakeRow[] = [];

  serviceCatalogEntry = {
    findMany: vi.fn(async (_args: { select: unknown; orderBy: { sortPosition: 'asc' } }) => {
      return [...this.rows].sort((a, b) => a.sortPosition - b.sortPosition);
    }),
    findUnique: vi.fn(async (args: { where: { kind: string }; select: unknown }) => {
      return this.rows.find((r) => r.kind === args.where.kind) ?? null;
    }),
    upsert: vi.fn(
      async (args: {
        where: { kind: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
        select: unknown;
      }) => {
        const existing = this.rows.find((r) => r.kind === args.where.kind);
        if (existing !== undefined) {
          for (const [key, value] of Object.entries(args.update)) {
            (existing as unknown as Record<string, unknown>)[key] = value;
          }
          existing.updatedAt = new Date('2026-05-25T02:00:00.000Z');
          return existing;
        }
        const row: FakeRow = {
          kind: args.create['kind'] as string,
          name: args.create['name'] as string,
          description: args.create['description'] as string,
          baseRateMin: args.create['baseRateMin'] as string,
          baseRateMax: args.create['baseRateMax'] as string,
          durationMinutes: args.create['durationMinutes'] as number,
          currency: args.create['currency'] as string,
          active: args.create['active'] as boolean,
          requiredProviderTier: args.create[
            'requiredProviderTier'
          ] as FakeRow['requiredProviderTier'],
          sortPosition: args.create['sortPosition'] as number,
          updatedAt: new Date('2026-05-25T02:00:00.000Z'),
        };
        this.rows.push(row);
        return row;
      },
    ),
  };
}

function makeRow(over: Partial<FakeRow> = {}): FakeRow {
  return {
    kind: 'companion_dining',
    name: 'Companion dining',
    description: 'A chef prepares and shares a meal with your loved one.',
    baseRateMin: '150.00',
    baseRateMax: '250.00',
    durationMinutes: 120,
    currency: 'USD',
    active: true,
    requiredProviderTier: null,
    sortPosition: 0,
    updatedAt: new Date('2026-05-25T00:00:00.000Z'),
    ...over,
  };
}

function build(): { prisma: FakePrisma; service: CatalogService } {
  const prisma = new FakePrisma();
  const service = new CatalogService(prisma as unknown as PrismaService);
  return { prisma, service };
}

const validUpsert = {
  name: 'Companion dining',
  description: 'A chef prepares and shares a meal with your loved one.',
  baseRateMinMinor: 15_000,
  baseRateMaxMinor: 25_000,
  durationMinutes: 120,
  currency: 'USD',
  active: true,
  requiredProviderTier: null,
  sortPosition: 0,
};

describe('CatalogService.list', () => {
  it('returns entries ordered by sortPosition with minor-unit conversion', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      makeRow({
        kind: 'transportation',
        sortPosition: 3,
        baseRateMin: '65.00',
        baseRateMax: '120.00',
      }),
      makeRow({ kind: 'companion_dining', sortPosition: 0 }),
    );

    const entries = await service.list();

    expect(entries.map((e) => e.kind)).toEqual(['companion_dining', 'transportation']);
    expect(entries[0]?.baseRateMinMinor).toBe(15_000);
    expect(entries[0]?.baseRateMaxMinor).toBe(25_000);
    expect(entries[1]?.baseRateMinMinor).toBe(6_500);
    expect(entries[1]?.baseRateMaxMinor).toBe(12_000);
  });

  it('returns an empty array when the catalog is empty', async () => {
    const { service } = build();
    expect(await service.list()).toEqual([]);
  });

  it('includes inactive entries (admin sees retired kinds)', async () => {
    const { prisma, service } = build();
    prisma.rows.push(makeRow({ kind: 'transportation', active: false, sortPosition: 3 }));
    const entries = await service.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.active).toBe(false);
  });
});

describe('CatalogService.getByKind', () => {
  it('returns the record for an existing kind', async () => {
    const { prisma, service } = build();
    prisma.rows.push(makeRow());
    const record = await service.getByKind('companion_dining');
    expect(record?.kind).toBe('companion_dining');
    expect(record?.durationMinutes).toBe(120);
    expect(record?.requiredProviderTier).toBeNull();
    expect(record?.updatedAt).toBe('2026-05-25T00:00:00.000Z');
  });

  it('surfaces the elite required tier for a Tier-3 concierge kind', async () => {
    const { prisma, service } = build();
    prisma.rows.push(
      makeRow({ kind: 'tea_social', requiredProviderTier: 'elite', sortPosition: 9 }),
    );
    const record = await service.getByKind('tea_social');
    expect(record?.requiredProviderTier).toBe('elite');
  });

  it('returns null for a kind with no row', async () => {
    const { service } = build();
    expect(await service.getByKind('event_dining')).toBeNull();
  });
});

describe('CatalogService.upsert', () => {
  it('creates a new row when none exists for the kind', async () => {
    const { prisma, service } = build();
    const result = await service.upsert('companion_dining', validUpsert);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('companion_dining');
      expect(result.value.baseRateMinMinor).toBe(15_000);
    }
    expect(prisma.rows).toHaveLength(1);
    // minor → Decimal string round-trip on the persisted row.
    expect(prisma.rows[0]?.baseRateMin).toBe('150.00');
    expect(prisma.rows[0]?.baseRateMax).toBe('250.00');
  });

  it('persists the required provider tier for a Tier-3 concierge kind', async () => {
    const { prisma, service } = build();
    const result = await service.upsert('tea_social', {
      ...validUpsert,
      requiredProviderTier: 'elite',
      sortPosition: 9,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requiredProviderTier).toBe('elite');
    }
    expect(prisma.rows[0]?.requiredProviderTier).toBe('elite');
  });

  it('updates the existing row when one already exists', async () => {
    const { prisma, service } = build();
    prisma.rows.push(makeRow({ active: true, baseRateMin: '150.00' }));

    const result = await service.upsert('companion_dining', {
      ...validUpsert,
      active: false,
      baseRateMinMinor: 17_500,
    });

    expect(result.ok).toBe(true);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]?.active).toBe(false);
    expect(prisma.rows[0]?.baseRateMin).toBe('175.00');
  });

  it('rejects a non-USD currency with unsupported_currency (no write)', async () => {
    const { prisma, service } = build();
    const result = await service.upsert('companion_dining', { ...validUpsert, currency: 'EUR' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('unsupported_currency');
    }
    expect(prisma.rows).toHaveLength(0);
  });

  it('rejects an inverted band with invalid_band (no write)', async () => {
    const { prisma, service } = build();
    const result = await service.upsert('companion_dining', {
      ...validUpsert,
      baseRateMinMinor: 30_000,
      baseRateMaxMinor: 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_band');
    }
    expect(prisma.rows).toHaveLength(0);
  });
});
