import 'reflect-metadata';

import type { ListProvidersQuery } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { ProviderDirectoryService } from './provider-directory.service';

/**
 * Unit tests for the directory read (TS-305c-followup-1).
 *
 * The load-bearing assertions here:
 *   - archived providers are EXCLUDED by default and included only on
 *     an explicit opt-in — and the opt-in WIDENS the set rather than
 *     narrowing it to archived rows;
 *   - the page query and the count query run against the SAME `where`,
 *     so the header count can never describe a different filter than
 *     the rows below it;
 *   - the ordering carries the `id` tiebreak, without which an offset
 *     page boundary can drop or repeat a duplicate display name;
 *   - the projection selects ten columns and NOT `bio` / the media
 *     keys — a list read must not carry a provider's prose.
 */

const ROW = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active' as const,
  tier: 'certified' as const,
  displayName: 'Chef Amara',
  headline: 'Slow-cooked comfort food',
  timeZone: 'America/New_York',
  dementiaSensitive: false,
  createdAt: new Date('2026-01-04T10:00:00.000Z'),
  deletedAt: null,
};

function query(overrides: Partial<ListProvidersQuery> = {}): ListProvidersQuery {
  return { includeArchived: false, limit: 25, offset: 0, ...overrides };
}

interface Harness {
  readonly service: ProviderDirectoryService;
  readonly capture: {
    findArgs?: Record<string, unknown>;
    countArgs?: Record<string, unknown>;
  };
}

function makeHarness(
  options: { readonly rows?: readonly unknown[]; readonly total?: number } = {},
): Harness {
  const capture: Harness['capture'] = {};

  const prisma = {
    provider: {
      findMany: async (args: Record<string, unknown>) => {
        capture.findArgs = args;
        return options.rows ?? [ROW];
      },
      count: async (args: Record<string, unknown>) => {
        capture.countArgs = args;
        return options.total ?? 1;
      },
    },
  } as unknown as PrismaService;

  return { service: new ProviderDirectoryService(prisma), capture };
}

describe('ProviderDirectoryService.list', () => {
  it('returns the page and the unpaged total', async () => {
    const { service } = makeHarness({ rows: [ROW], total: 187 });

    const page = await service.list(query());

    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(187);
  });

  it('excludes archived providers by default', async () => {
    const { service, capture } = makeHarness();

    await service.list(query());

    expect(capture.findArgs?.['where']).toEqual({ deletedAt: null });
  });

  it('WIDENS to all providers on includeArchived, never narrows to archived-only', async () => {
    // An operator searching for someone they suspect was archived does
    // not yet know whether they were. `deletedAt: { not: null }` would
    // hide the active answer to that search.
    const { service, capture } = makeHarness();

    await service.list(query({ includeArchived: true }));

    expect(capture.findArgs?.['where']).toEqual({});
  });

  it('runs the count against the SAME where clause as the page', async () => {
    const { service, capture } = makeHarness();

    await service.list(query({ status: 'suspended', tier: 'elite', q: 'amara' }));

    expect(capture.countArgs?.['where']).toEqual(capture.findArgs?.['where']);
  });

  it('applies status and tier as exact-match filters', async () => {
    const { service, capture } = makeHarness();

    await service.list(query({ status: 'suspended', tier: 'elite' }));

    expect(capture.findArgs?.['where']).toEqual({
      deletedAt: null,
      status: 'suspended',
      tier: 'elite',
    });
  });

  it('applies q as a case-insensitive substring match on displayName', async () => {
    const { service, capture } = makeHarness();

    await service.list(query({ q: 'amara' }));

    expect(capture.findArgs?.['where']).toEqual({
      deletedAt: null,
      displayName: { contains: 'amara', mode: 'insensitive' },
    });
  });

  it('omits every filter the caller did not send', async () => {
    const { service, capture } = makeHarness();

    await service.list(query());

    expect(Object.keys(capture.findArgs?.['where'] as object)).toEqual(['deletedAt']);
  });

  it('orders by displayName then id — the tiebreak is what makes paging stable', async () => {
    const { service, capture } = makeHarness();

    await service.list(query());

    expect(capture.findArgs?.['orderBy']).toEqual([{ displayName: 'asc' }, { id: 'asc' }]);
  });

  it('passes limit and offset through as take and skip', async () => {
    const { service, capture } = makeHarness();

    await service.list(query({ limit: 10, offset: 40 }));

    expect(capture.findArgs?.['take']).toBe(10);
    expect(capture.findArgs?.['skip']).toBe(40);
  });

  it('projects ten columns and NOT bio or the media keys', async () => {
    const { service, capture } = makeHarness();

    await service.list(query());

    const select = capture.findArgs?.['select'] as Record<string, boolean>;
    expect(Object.keys(select).sort()).toEqual(
      [
        'createdAt',
        'deletedAt',
        'dementiaSensitive',
        'displayName',
        'headline',
        'id',
        'status',
        'tier',
        'timeZone',
        'userId',
      ].sort(),
    );
    expect(select['bio']).toBeUndefined();
    expect(select['profilePhotoKey']).toBeUndefined();
    expect(select['videoIntroKey']).toBeUndefined();
  });

  it('does not paginate the count query', async () => {
    // A count with take/skip applied would report the page size, not the
    // match size — the exact number the console renders as "N match".
    const { service, capture } = makeHarness();

    await service.list(query({ limit: 5, offset: 10 }));

    expect(capture.countArgs?.['take']).toBeUndefined();
    expect(capture.countArgs?.['skip']).toBeUndefined();
  });

  it('returns an empty page without error when nothing matches', async () => {
    const { service } = makeHarness({ rows: [], total: 0 });

    const page = await service.list(query({ q: 'nobody' }));

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });
});
