import 'reflect-metadata';

import type { ListBookingHoldsQuery } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { SubjectHoldsReadService } from './subject-holds-read.service';

/**
 * Unit tests for the ops hold read (TS-304-followup-3).
 *
 * The load-bearing assertions:
 *   - `active` / `released` are predicates on `releasedAt`, and `all`
 *     omits the predicate entirely — there is no status column;
 *   - the page and the count share one `where`;
 *   - the booking count is ONE grouped query for the whole page, not
 *     one per row, and it is keyed by incident;
 *   - an incident with no suspended bookings is simply absent from the
 *     grouped result, which the caller maps to zero.
 */

const ROW = {
  id: 'bsh_1',
  incidentId: 'inc_1',
  subjectKind: 'provider' as const,
  subjectId: 'prov_1',
  severity: 'high',
  category: 'safety',
  heldAt: new Date('2026-07-20T10:00:00.000Z'),
  releasedAt: null,
};

function query(overrides: Partial<ListBookingHoldsQuery> = {}): ListBookingHoldsQuery {
  return { status: 'active', limit: 50, offset: 0, ...overrides };
}

interface Harness {
  readonly service: SubjectHoldsReadService;
  readonly capture: {
    findArgs?: Record<string, unknown>;
    countArgs?: Record<string, unknown>;
    groupArgs?: Record<string, unknown>;
    groupCalls: number;
  };
}

function makeHarness(
  options: {
    readonly rows?: readonly unknown[];
    readonly total?: number;
    readonly groups?: readonly unknown[];
  } = {},
): Harness {
  const capture: Harness['capture'] = { groupCalls: 0 };

  const prisma = {
    bookingSubjectHold: {
      findMany: async (args: Record<string, unknown>) => {
        capture.findArgs = args;
        return options.rows ?? [ROW];
      },
      count: async (args: Record<string, unknown>) => {
        capture.countArgs = args;
        return options.total ?? 1;
      },
    },
    booking: {
      groupBy: async (args: Record<string, unknown>) => {
        capture.groupArgs = args;
        capture.groupCalls += 1;
        return options.groups ?? [{ heldByIncidentId: 'inc_1', _count: { _all: 4 } }];
      },
    },
  } as unknown as PrismaService;

  return { service: new SubjectHoldsReadService(prisma), capture };
}

describe('SubjectHoldsReadService.listHolds', () => {
  it('returns the page, the total, and the per-incident counts', async () => {
    const { service } = makeHarness({ total: 12 });

    const page = await service.listHolds(query());

    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(12);
    expect(page.suspendedBookingCounts.get('inc_1')).toBe(4);
  });

  it('filters active holds on releasedAt: null', async () => {
    const { service, capture } = makeHarness();

    await service.listHolds(query({ status: 'active' }));

    expect(capture.findArgs?.['where']).toEqual({ releasedAt: null });
  });

  it('filters released holds on releasedAt: { not: null }', async () => {
    const { service, capture } = makeHarness();

    await service.listHolds(query({ status: 'released' }));

    expect(capture.findArgs?.['where']).toEqual({ releasedAt: { not: null } });
  });

  it('omits the releasedAt predicate entirely for status=all', async () => {
    const { service, capture } = makeHarness();

    await service.listHolds(query({ status: 'all' }));

    expect(capture.findArgs?.['where']).toEqual({});
  });

  it('applies the incident and subject filters', async () => {
    const { service, capture } = makeHarness();

    await service.listHolds(
      query({ incidentId: 'inc_9', subjectKind: 'senior', subjectId: 'sen_3' }),
    );

    expect(capture.findArgs?.['where']).toEqual({
      releasedAt: null,
      incidentId: 'inc_9',
      subjectKind: 'senior',
      subjectId: 'sen_3',
    });
  });

  it('runs the count against the SAME where clause as the page', async () => {
    const { service, capture } = makeHarness();

    await service.listHolds(query({ status: 'all', incidentId: 'inc_9' }));

    expect(capture.countArgs?.['where']).toEqual(capture.findArgs?.['where']);
  });

  it('orders heldAt DESC then incidentId then subjectKind so one incident stays adjacent', async () => {
    const { service, capture } = makeHarness();

    await service.listHolds(query());

    expect(capture.findArgs?.['orderBy']).toEqual([
      { heldAt: 'desc' },
      { incidentId: 'asc' },
      { subjectKind: 'asc' },
    ]);
  });

  it('passes limit and offset through as take and skip', async () => {
    const { service, capture } = makeHarness();

    await service.listHolds(query({ limit: 10, offset: 30 }));

    expect(capture.findArgs?.['take']).toBe(10);
    expect(capture.findArgs?.['skip']).toBe(30);
  });

  it('counts bookings in ONE grouped query for the whole page, deduping incident ids', async () => {
    const { service, capture } = makeHarness({
      rows: [
        ROW,
        { ...ROW, id: 'bsh_2', subjectKind: 'household' as const, subjectId: 'hh_1' },
        { ...ROW, id: 'bsh_3', incidentId: 'inc_2', subjectId: 'prov_2' },
      ],
      groups: [
        { heldByIncidentId: 'inc_1', _count: { _all: 4 } },
        { heldByIncidentId: 'inc_2', _count: { _all: 1 } },
      ],
    });

    const page = await service.listHolds(query());

    expect(capture.groupCalls).toBe(1);
    expect(capture.groupArgs?.['by']).toEqual(['heldByIncidentId']);
    expect(capture.groupArgs?.['where']).toEqual({
      heldByIncidentId: { in: ['inc_1', 'inc_2'] },
    });
    expect(page.suspendedBookingCounts.get('inc_1')).toBe(4);
    expect(page.suspendedBookingCounts.get('inc_2')).toBe(1);
  });

  it('skips the grouped query entirely when the page is empty', async () => {
    const { service, capture } = makeHarness({ rows: [], total: 0 });

    const page = await service.listHolds(query());

    expect(capture.groupCalls).toBe(0);
    expect(page.suspendedBookingCounts.size).toBe(0);
  });

  it('leaves an incident with no suspended bookings out of the map (caller maps it to zero)', async () => {
    const { service } = makeHarness({ groups: [] });

    const page = await service.listHolds(query());

    expect(page.suspendedBookingCounts.has('inc_1')).toBe(false);
  });

  it('ignores a null heldByIncidentId group rather than keying the map on it', async () => {
    const { service } = makeHarness({
      groups: [
        { heldByIncidentId: null, _count: { _all: 99 } },
        { heldByIncidentId: 'inc_1', _count: { _all: 2 } },
      ],
    });

    const page = await service.listHolds(query());

    expect(page.suspendedBookingCounts.size).toBe(1);
    expect(page.suspendedBookingCounts.get('inc_1')).toBe(2);
  });
});
