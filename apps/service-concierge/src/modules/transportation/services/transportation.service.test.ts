import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  TransportationService,
  type ConciergeTransportationRequestRow,
} from './transportation.service';

/**
 * Unit tests for `TransportationService` (TS-226).
 *
 * `FakePrisma` is an in-memory store implementing the narrow
 * `conciergeTransportationRequest` (findMany / findFirst / create / update) +
 * `conciergeTicket` (findFirst, for the ticket-household integrity check)
 * surface the service consumes. The FK / cascade behaviour + the real
 * transactional guarantees are covered by the Testcontainers integration test
 * (TS-226-followup); this suite pins the service's branching logic — including
 * the inbound ride-status webhook adapter path.
 */

interface RideSeed extends ConciergeTransportationRequestRow {
  readonly deletedAt: Date | null;
}

const PICKUP = new Date('2026-06-01T14:00:00.000Z');

let rideCounter = 0;

class FakePrisma {
  public rides: RideSeed[] = [];
  public tickets: { id: string; householdId: string; deletedAt: Date | null }[] = [];

  public get conciergeTransportationRequest(): {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      take?: number;
      select?: Record<string, boolean>;
    }) => Promise<RideSeed[]>;
    findFirst: (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<RideSeed | null>;
    create: (args: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<RideSeed>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<RideSeed>;
  } {
    return {
      findMany: async (args) => {
        let result = this.rides.filter((r) => matchesWhere(r, args.where));
        if (args.orderBy !== undefined) {
          result = [...result].sort((a, b) => compareByClauses(a, b, args.orderBy ?? []));
        }
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result;
      },
      findFirst: async (args) => this.rides.find((r) => matchesWhere(r, args.where)) ?? null,
      create: async (args) => {
        rideCounter += 1;
        const d = args.data;
        const row: RideSeed = {
          id: `ride_${rideCounter}`,
          householdId: String(d['householdId']),
          ticketId: (d['ticketId'] as string | null) ?? null,
          status: d['status'] as RideSeed['status'],
          externalProvider: d['externalProvider'] as RideSeed['externalProvider'],
          pickupAddress: String(d['pickupAddress']),
          dropoffAddress: String(d['dropoffAddress']),
          scheduledPickupAt: d['scheduledPickupAt'] as Date,
          purpose: (d['purpose'] as string | null) ?? null,
          riderName: (d['riderName'] as string | null) ?? null,
          externalReference: (d['externalReference'] as string | null) ?? null,
          externalStatus: (d['externalStatus'] as string | null) ?? null,
          notes: (d['notes'] as string | null) ?? null,
          createdByUserId: String(d['createdByUserId']),
          createdAt: PICKUP,
          updatedAt: PICKUP,
          deletedAt: null,
        };
        this.rides.push(row);
        return row;
      },
      update: async (args) => {
        const row = this.rides.find((r) => r.id === args.where.id);
        if (row === undefined) throw new Error(`ride ${args.where.id} not found`);
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

function rideRow(overrides: Partial<RideSeed> = {}): RideSeed {
  return {
    id: 'ride_seed',
    householdId: 'hh_1',
    ticketId: null,
    status: 'requested',
    externalProvider: 'manual',
    pickupAddress: '101 Park Ave, New York, NY',
    dropoffAddress: 'Mount Sinai, 1 Gustave L. Levy Pl',
    scheduledPickupAt: PICKUP,
    purpose: 'Cardiology follow-up',
    riderName: 'Eleanor',
    externalReference: null,
    externalStatus: null,
    notes: null,
    createdByUserId: 'user_concierge',
    createdAt: PICKUP,
    updatedAt: PICKUP,
    deletedAt: null,
    ...overrides,
  };
}

function makeService(fake: FakePrisma): TransportationService {
  return new TransportationService(fake as unknown as PrismaService);
}

const baseSchedule = {
  householdId: 'hh_1',
  pickupAddress: '101 Park Ave',
  dropoffAddress: 'Mount Sinai',
  scheduledPickupAt: PICKUP.toISOString(),
  externalProvider: 'manual',
  status: 'requested',
} as const;

describe('TransportationService.scheduleRide', () => {
  it('creates a ride with the actor as createdByUserId and no ticket link', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).scheduleRide({
      ...baseSchedule,
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.request.createdByUserId).toBe('user_42');
      expect(outcome.request.ticketId).toBeNull();
      expect(outcome.request.status).toBe('requested');
      expect(outcome.request.externalStatus).toBeNull();
    }
    expect(fake.rides).toHaveLength(1);
  });

  it('links a ticket that exists and belongs to the same household', async () => {
    const fake = new FakePrisma();
    fake.tickets = [{ id: 'tk_1', householdId: 'hh_1', deletedAt: null }];
    const outcome = await makeService(fake).scheduleRide({
      ...baseSchedule,
      ticketId: 'tk_1',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.request.ticketId).toBe('tk_1');
  });

  it('rejects a missing ticket with ticket_not_found (no write)', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).scheduleRide({
      ...baseSchedule,
      ticketId: 'nope',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ticket_not_found');
    expect(fake.rides).toHaveLength(0);
  });

  it('rejects a ticket from another household with ticket_household_mismatch', async () => {
    const fake = new FakePrisma();
    fake.tickets = [{ id: 'tk_other', householdId: 'hh_2', deletedAt: null }];
    const outcome = await makeService(fake).scheduleRide({
      ...baseSchedule,
      ticketId: 'tk_other',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ticket_household_mismatch');
    expect(fake.rides).toHaveLength(0);
  });

  it('treats a soft-deleted ticket as not found', async () => {
    const fake = new FakePrisma();
    fake.tickets = [{ id: 'tk_x', householdId: 'hh_1', deletedAt: new Date() }];
    const outcome = await makeService(fake).scheduleRide({
      ...baseSchedule,
      ticketId: 'tk_x',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('ticket_not_found');
  });

  it('persists a vendor provider + reference at schedule time', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).scheduleRide({
      ...baseSchedule,
      externalProvider: 'uber_health',
      externalReference: 'uber_ride_99',
      status: 'scheduled',
      actorUserId: 'user_42',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.request.externalProvider).toBe('uber_health');
      expect(outcome.request.externalReference).toBe('uber_ride_99');
      expect(outcome.request.status).toBe('scheduled');
    }
  });
});

describe('TransportationService.listRides', () => {
  it('orders by scheduledPickupAt ascending, excludes soft-deleted, honours limit', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({ id: 'ride_late', scheduledPickupAt: new Date('2026-06-10T12:00:00.000Z') }),
      rideRow({ id: 'ride_soon', scheduledPickupAt: new Date('2026-06-02T12:00:00.000Z') }),
      rideRow({ id: 'ride_deleted', scheduledPickupAt: PICKUP, deletedAt: new Date() }),
    ];
    const all = await makeService(fake).listRides({ limit: 50 });
    expect(all.map((r) => r.id)).toEqual(['ride_soon', 'ride_late']);
    const limited = await makeService(fake).listRides({ limit: 1 });
    expect(limited.map((r) => r.id)).toEqual(['ride_soon']);
  });

  it('filters by household / ticket / status / provider', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({
        id: 'ride_a',
        householdId: 'hh_1',
        ticketId: 'tk_1',
        status: 'requested',
        externalProvider: 'manual',
      }),
      rideRow({
        id: 'ride_b',
        householdId: 'hh_2',
        ticketId: 'tk_2',
        status: 'scheduled',
        externalProvider: 'uber_health',
      }),
    ];
    expect(
      (await makeService(fake).listRides({ householdId: 'hh_2', limit: 50 })).map((r) => r.id),
    ).toEqual(['ride_b']);
    expect(
      (await makeService(fake).listRides({ ticketId: 'tk_1', limit: 50 })).map((r) => r.id),
    ).toEqual(['ride_a']);
    expect(
      (await makeService(fake).listRides({ status: 'scheduled', limit: 50 })).map((r) => r.id),
    ).toEqual(['ride_b']);
    expect(
      (await makeService(fake).listRides({ externalProvider: 'uber_health', limit: 50 })).map(
        (r) => r.id,
      ),
    ).toEqual(['ride_b']);
  });

  it('upcomingOnly drops rides whose pickup is in the past', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({ id: 'ride_past', scheduledPickupAt: new Date('2020-01-01T00:00:00.000Z') }),
      rideRow({ id: 'ride_future', scheduledPickupAt: new Date('2999-01-01T00:00:00.000Z') }),
    ];
    const result = await makeService(fake).listRides({ upcomingOnly: true, limit: 50 });
    expect(result.map((r) => r.id)).toEqual(['ride_future']);
  });
});

describe('TransportationService.updateRide', () => {
  it('applies a valid status transition', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', status: 'requested' })];
    const outcome = await makeService(fake).updateRide({
      requestId: 'ride_1',
      actorUserId: 'user_ops',
      status: 'scheduled',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.request.status).toBe('scheduled');
    expect(fake.rides[0]?.status).toBe('scheduled');
  });

  it('allows the requested → in_progress jump for an on-demand ride', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', status: 'requested' })];
    const outcome = await makeService(fake).updateRide({
      requestId: 'ride_1',
      actorUserId: 'user_ops',
      status: 'in_progress',
    });
    expect(outcome.ok).toBe(true);
  });

  it('rejects a disallowed status transition with invalid_transition (no write)', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', status: 'requested' })];
    const outcome = await makeService(fake).updateRide({
      requestId: 'ride_1',
      actorUserId: 'user_ops',
      status: 'completed',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'invalid_transition') {
      expect(outcome.from).toBe('requested');
      expect(outcome.to).toBe('completed');
    } else {
      throw new Error('expected invalid_transition');
    }
    expect(fake.rides[0]?.status).toBe('requested');
  });

  it('cancels from a non-terminal state', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', status: 'scheduled' })];
    const outcome = await makeService(fake).updateRide({
      requestId: 'ride_1',
      actorUserId: 'user_ops',
      status: 'canceled',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.request.status).toBe('canceled');
  });

  it('rejects all edits on a terminal ride', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', status: 'completed' })];
    const outcome = await makeService(fake).updateRide({
      requestId: 'ride_1',
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

  it('returns not_found for a missing / soft-deleted ride', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', deletedAt: new Date() })];
    expect(
      (await makeService(fake).updateRide({ requestId: 'nope', actorUserId: 'u', notes: 'x' })).ok,
    ).toBe(false);
    expect(
      (await makeService(fake).updateRide({ requestId: 'ride_1', actorUserId: 'u', notes: 'x' }))
        .ok,
    ).toBe(false);
  });

  it('updates mutable fields and clears nullable ones', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', purpose: 'Old', externalReference: 'REF-1' })];
    const outcome = await makeService(fake).updateRide({
      requestId: 'ride_1',
      actorUserId: 'user_ops',
      purpose: null,
      externalReference: 'uber_42',
      notes: 'Wheelchair-accessible vehicle requested.',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.request.purpose).toBeNull();
      expect(outcome.request.externalReference).toBe('uber_42');
      expect(outcome.request.notes).toBe('Wheelchair-accessible vehicle requested.');
    }
  });

  it('treats a same-status PATCH as a no-op for status while applying other edits', async () => {
    const fake = new FakePrisma();
    fake.rides = [rideRow({ id: 'ride_1', status: 'scheduled' })];
    const outcome = await makeService(fake).updateRide({
      requestId: 'ride_1',
      actorUserId: 'user_ops',
      status: 'scheduled',
      notes: 'still on',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.request.status).toBe('scheduled');
      expect(outcome.request.notes).toBe('still on');
    }
  });
});

describe('TransportationService.applyWebhookEvent', () => {
  const baseEvent = {
    externalProvider: 'uber_health',
    externalReference: 'uber_ride_1',
    occurredAt: '2026-06-01T13:45:00.000Z',
  } as const;

  it('maps a recognised vendor status and applies it (applied)', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({
        id: 'ride_1',
        status: 'scheduled',
        externalProvider: 'uber_health',
        externalReference: 'uber_ride_1',
      }),
    ];
    const result = await makeService(fake).applyWebhookEvent({
      ...baseEvent,
      externalStatus: 'arriving',
    });
    expect(result.outcome).toBe('applied');
    expect(result.status).toBe('in_progress');
    expect(fake.rides[0]?.status).toBe('in_progress');
    expect(fake.rides[0]?.externalStatus).toBe('arriving');
  });

  it('returns unchanged when the mapped status equals the current one (still records raw)', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({
        id: 'ride_1',
        status: 'scheduled',
        externalProvider: 'uber_health',
        externalReference: 'uber_ride_1',
      }),
    ];
    const result = await makeService(fake).applyWebhookEvent({
      ...baseEvent,
      externalStatus: 'accepted',
    });
    expect(result.outcome).toBe('unchanged');
    expect(result.status).toBe('scheduled');
    expect(fake.rides[0]?.externalStatus).toBe('accepted');
  });

  it('returns unrecognized_status for an unmapped raw value (records raw, status untouched)', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({
        id: 'ride_1',
        status: 'scheduled',
        externalProvider: 'uber_health',
        externalReference: 'uber_ride_1',
      }),
    ];
    const result = await makeService(fake).applyWebhookEvent({
      ...baseEvent,
      externalStatus: 'gremlin',
    });
    expect(result.outcome).toBe('unrecognized_status');
    expect(result.status).toBe('scheduled');
    expect(fake.rides[0]?.status).toBe('scheduled');
    expect(fake.rides[0]?.externalStatus).toBe('gremlin');
  });

  it('returns already_terminal for a completed/canceled ride (records raw, never resurrects)', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({
        id: 'ride_1',
        status: 'completed',
        externalProvider: 'uber_health',
        externalReference: 'uber_ride_1',
      }),
    ];
    const result = await makeService(fake).applyWebhookEvent({
      ...baseEvent,
      externalStatus: 'arriving',
    });
    expect(result.outcome).toBe('already_terminal');
    expect(result.status).toBe('completed');
    expect(fake.rides[0]?.status).toBe('completed');
    expect(fake.rides[0]?.externalStatus).toBe('arriving');
  });

  it('returns not_found when no ride matches the (provider, reference)', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({ id: 'ride_1', externalProvider: 'uber_health', externalReference: 'other' }),
    ];
    const result = await makeService(fake).applyWebhookEvent({
      ...baseEvent,
      externalStatus: 'arriving',
    });
    expect(result.outcome).toBe('not_found');
    expect(result.status).toBeNull();
  });

  it('does not match a ride from a different vendor with the same reference', async () => {
    const fake = new FakePrisma();
    fake.rides = [
      rideRow({ id: 'ride_1', externalProvider: 'lyft_health', externalReference: 'uber_ride_1' }),
    ];
    const result = await makeService(fake).applyWebhookEvent({
      ...baseEvent,
      externalStatus: 'arriving',
    });
    expect(result.outcome).toBe('not_found');
  });
});
