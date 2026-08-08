import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { TicketsService, type ConciergeTicketRow } from './tickets.service';

/**
 * Unit tests for `TicketsService` (TS-223).
 *
 * `FakePrisma` is an in-memory store implementing the narrow surface the
 * service consumes: `conciergeAssignment.findFirst` (the in-service
 * routing lookup) + `conciergeTicket.create` / `findMany`. No real
 * transactional behaviour — the integration test against a real Postgres
 * carries the migration + persistence guarantees.
 */

interface AssignmentRow {
  readonly householdId: string;
  readonly primaryConciergeUserId: string;
  readonly status: 'active' | 'ended';
  readonly deletedAt: Date | null;
}

interface CreateArgs {
  readonly data: Record<string, unknown>;
  readonly select?: Record<string, boolean>;
}
interface FindFirstArgs {
  readonly where: Record<string, unknown>;
  readonly select?: Record<string, boolean>;
}
interface FindManyArgs {
  readonly where: Record<string, unknown>;
  readonly orderBy?: Record<string, 'asc' | 'desc'>;
  readonly take?: number;
  readonly select?: Record<string, boolean>;
}

let idCounter = 0;

class FakePrisma {
  public assignments: AssignmentRow[] = [];
  public tickets: ConciergeTicketRow[] = [];

  get conciergeAssignment(): {
    findFirst: (args: FindFirstArgs) => Promise<{ primaryConciergeUserId: string } | null>;
  } {
    return {
      findFirst: async (args) => {
        const match = this.assignments.find((row) =>
          Object.entries(args.where).every(
            ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
          ),
        );
        return match === undefined
          ? null
          : { primaryConciergeUserId: match.primaryConciergeUserId };
      },
    };
  }

  get conciergeTicket(): {
    create: (args: CreateArgs) => Promise<ConciergeTicketRow>;
    findMany: (args: FindManyArgs) => Promise<ConciergeTicketRow[]>;
  } {
    return {
      create: async (args) => {
        idCounter += 1;
        const now = new Date('2026-06-01T09:00:00.000Z');
        const data = args.data;
        const row: ConciergeTicketRow = {
          id: `tk_${idCounter}`,
          householdId: String(data['householdId']),
          kind: data['kind'] as ConciergeTicketRow['kind'],
          status: data['status'] as ConciergeTicketRow['status'],
          subject: String(data['subject']),
          body: String(data['body']),
          requestedDate: (data['requestedDate'] as Date | null) ?? null,
          partySize: (data['partySize'] as number | null) ?? null,
          theme: (data['theme'] as string | null) ?? null,
          slaDueAt: (data['slaDueAt'] as Date | null) ?? null,
          assignedToUserId: (data['assignedToUserId'] as string | null) ?? null,
          escalationPath:
            (data['escalationPath'] as ConciergeTicketRow['escalationPath']) ?? 'standard',
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        this.tickets.push(row);
        return row;
      },
      findMany: async (args) => {
        let result = this.tickets.filter((row) =>
          Object.entries(args.where).every(
            ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value,
          ),
        );
        const order = args.orderBy;
        if (order !== undefined) {
          const entry = Object.entries(order)[0];
          if (entry !== undefined) {
            const [key, dir] = entry;
            result = [...result].sort((a, b) => {
              const av = (a as unknown as Record<string, unknown>)[key];
              const bv = (b as unknown as Record<string, unknown>)[key];
              const an = av instanceof Date ? av.getTime() : String(av);
              const bn = bv instanceof Date ? bv.getTime() : String(bv);
              const cmp = an < bn ? -1 : an > bn ? 1 : 0;
              return dir === 'asc' ? cmp : -cmp;
            });
          }
        }
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result;
      },
    };
  }
}

function buildService(prisma: FakePrisma): TicketsService {
  return new TicketsService(prisma as unknown as PrismaService);
}

const BASE_INPUT = {
  householdId: 'hh_1',
  kind: 'holiday_dinner' as const,
  subject: 'Thanksgiving supper for Mom',
  body: 'A small traditional turkey dinner.',
  requestedDate: '2026-11-26' as string | null,
  partySize: 6 as number | null,
  theme: 'Traditional' as string | null,
};

describe('TicketsService.submitRequest', () => {
  it('routes to the household active primary concierge when one is assigned', async () => {
    const prisma = new FakePrisma();
    prisma.assignments.push({
      householdId: 'hh_1',
      primaryConciergeUserId: 'user_primary',
      status: 'active',
      deletedAt: null,
    });
    const service = buildService(prisma);

    const ticket = await service.submitRequest({ ...BASE_INPUT });

    expect(ticket.status).toBe('assigned');
    expect(ticket.assignedToUserId).toBe('user_primary');
    expect(prisma.tickets).toHaveLength(1);
  });

  it('lands open + unassigned when the household has no dedicated concierge', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const ticket = await service.submitRequest({ ...BASE_INPUT, householdId: 'hh_none' });

    expect(ticket.status).toBe('open');
    expect(ticket.assignedToUserId).toBeNull();
  });

  it('ignores an ended assignment (routes to the open queue)', async () => {
    const prisma = new FakePrisma();
    prisma.assignments.push({
      householdId: 'hh_1',
      primaryConciergeUserId: 'user_old',
      status: 'ended',
      deletedAt: null,
    });
    const service = buildService(prisma);

    const ticket = await service.submitRequest({ ...BASE_INPUT });

    expect(ticket.status).toBe('open');
    expect(ticket.assignedToUserId).toBeNull();
  });

  it('stamps a per-kind SLA deadline (holiday_dinner = 72h)', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const before = Date.now();
    const ticket = await service.submitRequest({ ...BASE_INPUT });

    expect(ticket.slaDueAt).not.toBeNull();
    const slaMs = Date.parse(ticket.slaDueAt as string);
    const expected = before + 72 * 60 * 60 * 1000;
    // Within a minute of now + the policy hours.
    expect(Math.abs(slaMs - expected)).toBeLessThan(60_000);
  });

  it('gives a custom_request the 48h SLA', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const before = Date.now();
    const ticket = await service.submitRequest({ ...BASE_INPUT, kind: 'custom_request' });

    const slaMs = Date.parse(ticket.slaDueAt as string);
    expect(Math.abs(slaMs - (before + 48 * 60 * 60 * 1000))).toBeLessThan(60_000);
  });

  it('projects the requested date to a YYYY-MM-DD string', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const ticket = await service.submitRequest({ ...BASE_INPUT, requestedDate: '2026-11-26' });

    expect(ticket.requestedDate).toBe('2026-11-26');
  });

  it('persists null structured fields when omitted', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const ticket = await service.submitRequest({
      ...BASE_INPUT,
      requestedDate: null,
      partySize: null,
      theme: null,
    });

    expect(ticket.requestedDate).toBeNull();
    expect(ticket.partySize).toBeNull();
    expect(ticket.theme).toBeNull();
  });

  it('always opens at the standard escalation path', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const ticket = await service.submitRequest({ ...BASE_INPUT });

    expect(ticket.escalationPath).toBe('standard');
  });
});

describe('TicketsService.listForHousehold', () => {
  it('returns the household requests newest-first', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.submitRequest({ ...BASE_INPUT, subject: 'first' });
    await service.submitRequest({ ...BASE_INPUT, subject: 'second' });
    // Force a deterministic createdAt ordering on the in-memory rows.
    prisma.tickets[0] = { ...prisma.tickets[0]!, createdAt: new Date('2026-06-01T08:00:00.000Z') };
    prisma.tickets[1] = { ...prisma.tickets[1]!, createdAt: new Date('2026-06-01T10:00:00.000Z') };

    const list = await service.listForHousehold({ householdId: 'hh_1', limit: 50 });

    expect(list).toHaveLength(2);
    expect(list[0]?.subject).toBe('second');
    expect(list[1]?.subject).toBe('first');
  });

  it('scopes to the household and excludes other households', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.submitRequest({ ...BASE_INPUT, householdId: 'hh_1' });
    await service.submitRequest({ ...BASE_INPUT, householdId: 'hh_2' });

    const list = await service.listForHousehold({ householdId: 'hh_1', limit: 50 });

    expect(list).toHaveLength(1);
    expect(list[0]?.householdId).toBe('hh_1');
  });

  it('honours the limit', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.submitRequest({ ...BASE_INPUT });
    await service.submitRequest({ ...BASE_INPUT });
    await service.submitRequest({ ...BASE_INPUT });

    const list = await service.listForHousehold({ householdId: 'hh_1', limit: 2 });

    expect(list).toHaveLength(2);
  });

  it('returns an empty array for a household with no requests', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    expect(await service.listForHousehold({ householdId: 'hh_none', limit: 50 })).toEqual([]);
  });
});
