import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { SLA_DUE_SOON_MINUTES, SlaBreachSweepService } from './sla-breach-sweep.service';

/**
 * Unit tests for the SLA-breach scan (TS-306-followup-1a).
 *
 * The assertions that carry weight:
 *   - the count and the enumeration are INDEPENDENT, so a capped
 *     enumeration cannot make the metric under-report — and truncation is
 *     stated rather than implied by a short list;
 *   - breached and due-soon PARTITION the unresolved set: an incident
 *     exactly at its deadline is breached, not upcoming;
 *   - resolved incidents are excluded by a NOT, matching the repository's
 *     own predicate and the partial index;
 *   - each row carries the budget IN FORCE beside the overdue figure — a
 *     measurement without its threshold reads as a verdict
 *     (TS-308c-followup-2's console rule);
 *   - the projection carries no `description` and no subject ids.
 */

const NOW = new Date('2026-07-27T12:00:00.000Z');
const MINUTE = 60_000;

interface Capture {
  readonly counts: Array<Record<string, unknown>>;
  readonly finds: Array<Record<string, unknown>>;
}

function makePrisma(
  rows: ReadonlyArray<Record<string, unknown>>,
  counts: readonly number[],
): { prisma: PrismaService; capture: Capture } {
  const capture: Capture = { counts: [], finds: [] };
  let countCall = 0;
  const prisma = {
    incident: {
      count: async (args: Record<string, unknown>) => {
        capture.counts.push(args);
        const value = counts[countCall] ?? 0;
        countCall += 1;
        return value;
      },
      findMany: async (args: Record<string, unknown>) => {
        capture.finds.push(args);
        const take = (args as { take?: number }).take ?? rows.length;
        return rows.slice(0, take);
      },
    },
  } as unknown as PrismaService;
  return { prisma, capture };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inc_1',
    severity: 'high',
    category: 'welfare',
    status: 'open',
    slaDueAt: new Date(NOW.getTime() - 90 * MINUTE),
    ...overrides,
  };
}

describe('SlaBreachSweepService', () => {
  it('reports the breached and due-soon counts from their own queries', async () => {
    const { prisma } = makePrisma([row()], [3, 7]);
    const service = new SlaBreachSweepService(prisma);

    const result = await service.sweep({ now: NOW, maxLogged: 25 });

    expect(result.breachedCount).toBe(3);
    expect(result.dueSoonCount).toBe(7);
  });

  it('the COUNT is never capped by the enumeration cap', async () => {
    const { prisma } = makePrisma([row({ id: 'a' }), row({ id: 'b' })], [40, 0]);
    const service = new SlaBreachSweepService(prisma);

    const result = await service.sweep({ now: NOW, maxLogged: 2 });

    expect(result.breachedCount).toBe(40);
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation when everything breached was enumerated', async () => {
    const { prisma } = makePrisma([row()], [1, 0]);
    const service = new SlaBreachSweepService(prisma);

    expect((await service.sweep({ now: NOW, maxLogged: 25 })).truncated).toBe(false);
  });

  it('excludes resolved incidents with a NOT, matching the partial index', async () => {
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new SlaBreachSweepService(prisma);

    await service.sweep({ now: NOW, maxLogged: 25 });

    expect((capture.counts[0]?.where as { status: unknown }).status).toEqual({ not: 'resolved' });
  });

  it('partitions the unresolved set — the deadline instant is BREACHED, not due-soon', async () => {
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new SlaBreachSweepService(prisma);

    await service.sweep({ now: NOW, maxLogged: 25 });

    const breached = capture.counts[0]?.where as { slaDueAt: { lt: Date } };
    const soon = capture.counts[1]?.where as { slaDueAt: { gte: Date; lt: Date } };
    expect(breached.slaDueAt.lt).toEqual(NOW);
    expect(soon.slaDueAt.gte).toEqual(NOW);
    expect(soon.slaDueAt.lt).toEqual(new Date(NOW.getTime() + SLA_DUE_SOON_MINUTES * MINUTE));
  });

  it('pins the lead time to the SHORTEST budget in force', async () => {
    // A lead-time longer than a severity's whole budget would make every
    // `critical` incident "due soon" from the moment it opens, which is
    // the same as saying nothing.
    expect(SLA_DUE_SOON_MINUTES).toBe(120);
  });

  it('enumerates deadline-soonest first, tie-broken by id', async () => {
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new SlaBreachSweepService(prisma);

    await service.sweep({ now: NOW, maxLogged: 25 });

    expect(capture.finds[0]?.orderBy).toEqual([{ slaDueAt: 'asc' }, { id: 'asc' }]);
  });

  it('states the budget IN FORCE beside the overdue figure', async () => {
    // A number without its threshold reads as a verdict. `high` is 480
    // minutes; a 90-minute overdue against that is a different situation
    // from 90 minutes against `critical`'s 120.
    const { prisma } = makePrisma(
      [row({ severity: 'high' }), row({ severity: 'critical' })],
      [2, 0],
    );
    const service = new SlaBreachSweepService(prisma);

    const result = await service.sweep({ now: NOW, maxLogged: 25 });

    expect(result.rows[0]).toMatchObject({ minutesOverdue: 90, budgetMinutes: 480 });
    expect(result.rows[1]).toMatchObject({ minutesOverdue: 90, budgetMinutes: 120 });
  });

  it('projects NO description and NO subject ids', async () => {
    // `description` is a family's account of a named senior. An operator
    // opens the incident by id in the `trust_safety:write`-gated console.
    const { prisma, capture } = makePrisma([], [0, 0]);
    const service = new SlaBreachSweepService(prisma);

    await service.sweep({ now: NOW, maxLogged: 25 });

    const select = capture.finds[0]?.select as Record<string, boolean>;
    for (const forbidden of [
      'description',
      'providerId',
      'seniorId',
      'householdId',
      'reporterUserId',
      'resolutionNotes',
    ]) {
      expect(select[forbidden]).toBeUndefined();
    }
  });

  it('emitted rows serialise without any free text or subject id', async () => {
    const { prisma } = makePrisma(
      [
        row({
          description: 'she has not eaten since Tuesday and her daughter is worried',
          seniorId: 'sen_secret',
        }),
      ],
      [1, 0],
    );
    const service = new SlaBreachSweepService(prisma);

    const serialised = JSON.stringify((await service.sweep({ now: NOW, maxLogged: 25 })).rows);

    expect(serialised).not.toContain('has not eaten');
    expect(serialised).not.toContain('sen_secret');
  });

  it('a clean queue is a clean result, not an empty one', async () => {
    const { prisma } = makePrisma([], [0, 0]);
    const service = new SlaBreachSweepService(prisma);

    expect(await service.sweep({ now: NOW, maxLogged: 25 })).toEqual({
      breachedCount: 0,
      dueSoonCount: 0,
      rows: [],
      truncated: false,
    });
  });
});
