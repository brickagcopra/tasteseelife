import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  ScheduledEventsService,
  type ConciergeScheduledEventRow,
} from './scheduled-events.service';

/**
 * Unit tests for `ScheduledEventsService` (TS-227).
 *
 * `FakePrisma` is an in-memory store implementing the narrow
 * `conciergeScheduledEvent` (findMany / findFirst / create / update) +
 * `conciergeTicket` (findFirst, for the ticket-household integrity check)
 * surface the service consumes. The FK / cascade behaviour + the real
 * transactional guarantees are covered by the Testcontainers integration test
 * (TS-227-followup-2); this suite pins the service's branching logic.
 */

interface EventSeed extends ConciergeScheduledEventRow {
  readonly deletedAt: Date | null;
}

const START = new Date('2026-06-01T18:00:00.000Z');
const END = new Date('2026-06-01T20:30:00.000Z');

let eventCounter = 0;

class FakePrisma {
  public events: EventSeed[] = [];
  public tickets: { id: string; householdId: string; deletedAt: Date | null }[] = [];

  public get conciergeScheduledEvent(): {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      take?: number;
      select?: Record<string, boolean>;
    }) => Promise<EventSeed[]>;
    findFirst: (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<EventSeed | null>;
    create: (args: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<EventSeed>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<EventSeed>;
  } {
    return {
      findMany: async (args) => {
        let result = this.events.filter((e) => matchesWhere(e, args.where));
        if (args.orderBy !== undefined) {
          result = [...result].sort((a, b) => compareByClauses(a, b, args.orderBy ?? []));
        }
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result;
      },
      findFirst: async (args) => this.events.find((e) => matchesWhere(e, args.where)) ?? null,
      create: async (args) => {
        eventCounter += 1;
        const d = args.data;
        const row: EventSeed = {
          id: `ev_${eventCounter}`,
          householdId: String(d['householdId']),
          ticketId: (d['ticketId'] as string | null) ?? null,
          kind: d['kind'] as EventSeed['kind'],
          status: d['status'] as EventSeed['status'],
          title: String(d['title']),
          venueName: (d['venueName'] as string | null) ?? null,
          venueAddress: (d['venueAddress'] as string | null) ?? null,
          scheduledStart: d['scheduledStart'] as Date,
          scheduledEnd: (d['scheduledEnd'] as Date | null) ?? null,
          partySize: (d['partySize'] as number | null) ?? null,
          externalProvider: d['externalProvider'] as EventSeed['externalProvider'],
          externalReference: (d['externalReference'] as string | null) ?? null,
          notes: (d['notes'] as string | null) ?? null,
          createdByUserId: String(d['createdByUserId']),
          createdAt: START,
          updatedAt: START,
          deletedAt: null,
        };
        this.events.push(row);
        return row;
      },
      update: async (args) => {
        const row = this.events.find((e) => e.id === args.where.id);
        if (row === undefined) throw new Error(`event ${args.where.id} not found`);
        Object.assign(row, args.data, { updatedAt: new Date('2026-06-02T00:00:00.000Z') });
        return row;
      },
    };
  }

  public get conciergeTicket(): {
    findFirst: (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<{ householdId: string } | null>;
  } {
    return {
      findFirst: async (args) => {
        const row = this.tickets.find((t) => matchesWhere(t, args.where));
        return row === undefined ? null : { householdId: row.householdId };
      },
    };
  }
}

function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  const bag = row as Record<string, unknown>;
  for (const [key, expected] of Object.entries(where)) {
    const actual = bag[key];
    if (expected === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (expected !== null && typeof expected === 'object' && 'gte' in (expected as object)) {
      const gte = (expected as { gte: Date }).gte;
      if (!(actual instanceof Date) || actual.getTime() < gte.getTime()) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function compareByClauses(
  a: object,
  b: object,
  clauses: ReadonlyArray<Record<string, 'asc' | 'desc'>>,
): number {
  const bagA = a as Record<string, unknown>;
  const bagB = b as Record<string, unknown>;
  for (const clause of clauses) {
    const entry = Object.entries(clause)[0];
    if (entry === undefined) continue;
    const [key, dir] = entry;
    const cmp = compareValues(bagA[key], bagB[key]);
    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return 0;
}

function eventRow(overrides: Partial<EventSeed> = {}): EventSeed {
  return {
    id: 'ev_seed',
    householdId: 'hh_1',
    ticketId: null,
    kind: 'restaurant_reservation',
    status: 'proposed',
    title: 'Dinner at Carbone',
    venueName: 'Carbone',
    venueAddress: null,
    scheduledStart: START,
    scheduledEnd: END,
    partySize: 4,
    externalProvider: 'manual',
    externalReference: null,
    notes: null,
    createdByUserId: 'user_concierge',
    createdAt: START,
    updatedAt: START,
    deletedAt: null,
    ...overrides,
  };
}

function makeService(fake: FakePrisma): ScheduledEventsService {
  return new ScheduledEventsService(fake as unknown as PrismaService);
}

const baseSchedule = {
  householdId: 'hh_1',
  kind: 'cultural_event',
  title: 'MoMA tour',
  scheduledStart: START.toISOString(),
  externalProvider: 'manual',
  status: 'proposed',
} as const;

describe('ScheduledEventsService.scheduleEvent', () => {
  it('creates an event with the actor as createdByUserId and no ticket link', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).scheduleEvent({
      ...baseSchedule,
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.event.createdByUserId).toBe('user_42');
      expect(outcome.event.ticketId).toBeNull();
      expect(outcome.event.status).toBe('proposed');
      expect(outcome.event.scheduledEnd).toBeNull();
    }
    expect(fake.events).toHaveLength(1);
  });

  it('links a ticket that exists and belongs to the same household', async () => {
    const fake = new FakePrisma();
    fake.tickets = [{ id: 'tk_1', householdId: 'hh_1', deletedAt: null }];
    const outcome = await makeService(fake).scheduleEvent({
      ...baseSchedule,
      ticketId: 'tk_1',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.event.ticketId).toBe('tk_1');
  });

  it('rejects a missing ticket with ticket_not_found (no write)', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).scheduleEvent({
      ...baseSchedule,
      ticketId: 'nope',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ticket_not_found');
    expect(fake.events).toHaveLength(0);
  });

  it('rejects a ticket from another household with ticket_household_mismatch', async () => {
    const fake = new FakePrisma();
    fake.tickets = [{ id: 'tk_other', householdId: 'hh_2', deletedAt: null }];
    const outcome = await makeService(fake).scheduleEvent({
      ...baseSchedule,
      ticketId: 'tk_other',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ticket_household_mismatch');
    expect(fake.events).toHaveLength(0);
  });

  it('treats a soft-deleted ticket as not found', async () => {
    const fake = new FakePrisma();
    fake.tickets = [{ id: 'tk_x', householdId: 'hh_1', deletedAt: new Date() }];
    const outcome = await makeService(fake).scheduleEvent({
      ...baseSchedule,
      ticketId: 'tk_x',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ticket_not_found');
  });

  it('persists a supplied scheduledEnd', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).scheduleEvent({
      ...baseSchedule,
      scheduledEnd: END.toISOString(),
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.event.scheduledEnd).toBe(END.toISOString());
  });
});

describe('ScheduledEventsService.listEvents', () => {
  it('orders by scheduledStart ascending, excludes soft-deleted, honours limit', async () => {
    const fake = new FakePrisma();
    fake.events = [
      eventRow({ id: 'ev_late', scheduledStart: new Date('2026-06-10T12:00:00.000Z') }),
      eventRow({ id: 'ev_soon', scheduledStart: new Date('2026-06-02T12:00:00.000Z') }),
      eventRow({ id: 'ev_deleted', scheduledStart: START, deletedAt: new Date() }),
    ];
    const all = await makeService(fake).listEvents({ limit: 50 });
    expect(all.map((e) => e.id)).toEqual(['ev_soon', 'ev_late']);
    const limited = await makeService(fake).listEvents({ limit: 1 });
    expect(limited.map((e) => e.id)).toEqual(['ev_soon']);
  });

  it('filters by household / ticket / status / kind', async () => {
    const fake = new FakePrisma();
    fake.events = [
      eventRow({
        id: 'ev_a',
        householdId: 'hh_1',
        ticketId: 'tk_1',
        status: 'proposed',
        kind: 'restaurant_reservation',
      }),
      eventRow({
        id: 'ev_b',
        householdId: 'hh_2',
        ticketId: 'tk_2',
        status: 'confirmed',
        kind: 'group_outing',
      }),
    ];
    expect(
      (await makeService(fake).listEvents({ householdId: 'hh_2', limit: 50 })).map((e) => e.id),
    ).toEqual(['ev_b']);
    expect(
      (await makeService(fake).listEvents({ ticketId: 'tk_1', limit: 50 })).map((e) => e.id),
    ).toEqual(['ev_a']);
    expect(
      (await makeService(fake).listEvents({ status: 'confirmed', limit: 50 })).map((e) => e.id),
    ).toEqual(['ev_b']);
    expect(
      (await makeService(fake).listEvents({ kind: 'group_outing', limit: 50 })).map((e) => e.id),
    ).toEqual(['ev_b']);
  });

  it('upcomingOnly drops events whose start is in the past', async () => {
    const fake = new FakePrisma();
    fake.events = [
      eventRow({ id: 'ev_past', scheduledStart: new Date('2020-01-01T00:00:00.000Z') }),
      eventRow({ id: 'ev_future', scheduledStart: new Date('2999-01-01T00:00:00.000Z') }),
    ];
    const result = await makeService(fake).listEvents({ upcomingOnly: true, limit: 50 });
    expect(result.map((e) => e.id)).toEqual(['ev_future']);
  });
});

describe('ScheduledEventsService.updateEvent', () => {
  it('applies a valid status transition', async () => {
    const fake = new FakePrisma();
    fake.events = [eventRow({ id: 'ev_1', status: 'proposed' })];
    const outcome = await makeService(fake).updateEvent({
      eventId: 'ev_1',
      actorUserId: 'user_ops',
      status: 'confirmed',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.event.status).toBe('confirmed');
    expect(fake.events[0]?.status).toBe('confirmed');
  });

  it('rejects a disallowed status transition with invalid_transition (no write)', async () => {
    const fake = new FakePrisma();
    fake.events = [eventRow({ id: 'ev_1', status: 'proposed' })];
    const outcome = await makeService(fake).updateEvent({
      eventId: 'ev_1',
      actorUserId: 'user_ops',
      status: 'completed',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'invalid_transition') {
      expect(outcome.from).toBe('proposed');
      expect(outcome.to).toBe('completed');
    } else {
      throw new Error('expected invalid_transition');
    }
    expect(fake.events[0]?.status).toBe('proposed');
  });

  it('rejects all edits on a terminal event', async () => {
    const fake = new FakePrisma();
    fake.events = [eventRow({ id: 'ev_1', status: 'completed' })];
    const outcome = await makeService(fake).updateEvent({
      eventId: 'ev_1',
      actorUserId: 'user_ops',
      notes: 'late edit',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'terminal') {
      expect(outcome.status).toBe('completed');
    } else {
      throw new Error('expected terminal');
    }
  });

  it('returns not_found for a missing / soft-deleted event', async () => {
    const fake = new FakePrisma();
    fake.events = [eventRow({ id: 'ev_1', deletedAt: new Date() })];
    expect(
      (await makeService(fake).updateEvent({ eventId: 'nope', actorUserId: 'u', notes: 'x' })).ok,
    ).toBe(false);
    expect(
      (await makeService(fake).updateEvent({ eventId: 'ev_1', actorUserId: 'u', notes: 'x' })).ok,
    ).toBe(false);
  });

  it('updates mutable fields and clears nullable ones', async () => {
    const fake = new FakePrisma();
    fake.events = [eventRow({ id: 'ev_1', venueName: 'Old', externalReference: 'REF-1' })];
    const outcome = await makeService(fake).updateEvent({
      eventId: 'ev_1',
      actorUserId: 'user_ops',
      venueName: null,
      externalReference: 'OT-777',
      notes: 'Confirmed by phone.',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.event.venueName).toBeNull();
      expect(outcome.event.externalReference).toBe('OT-777');
      expect(outcome.event.notes).toBe('Confirmed by phone.');
    }
  });

  it('rejects a merged non-monotonic start/end with invalid_time_range', async () => {
    const fake = new FakePrisma();
    // current start 18:00, end 20:30; move end to 17:00 (before current start).
    fake.events = [eventRow({ id: 'ev_1' })];
    const outcome = await makeService(fake).updateEvent({
      eventId: 'ev_1',
      actorUserId: 'user_ops',
      scheduledEnd: new Date('2026-06-01T17:00:00.000Z').toISOString(),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('invalid_time_range');
  });

  it('allows a full reschedule of start + end together', async () => {
    const fake = new FakePrisma();
    fake.events = [eventRow({ id: 'ev_1' })];
    const newStart = new Date('2026-07-01T18:00:00.000Z').toISOString();
    const newEnd = new Date('2026-07-01T21:00:00.000Z').toISOString();
    const outcome = await makeService(fake).updateEvent({
      eventId: 'ev_1',
      actorUserId: 'user_ops',
      scheduledStart: newStart,
      scheduledEnd: newEnd,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.event.scheduledStart).toBe(newStart);
      expect(outcome.event.scheduledEnd).toBe(newEnd);
    }
  });

  it('treats a same-status PATCH as a no-op for status while applying other edits', async () => {
    const fake = new FakePrisma();
    fake.events = [eventRow({ id: 'ev_1', status: 'confirmed' })];
    const outcome = await makeService(fake).updateEvent({
      eventId: 'ev_1',
      actorUserId: 'user_ops',
      status: 'confirmed',
      notes: 'still on',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.event.status).toBe('confirmed');
      expect(outcome.event.notes).toBe('still on');
    }
  });
});
