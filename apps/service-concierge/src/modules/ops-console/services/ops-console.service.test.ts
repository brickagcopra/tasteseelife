import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  OpsConsoleService,
  type ConciergeTicketNoteRow,
  type ConciergeTicketRow,
} from './ops-console.service';

/**
 * Unit tests for `OpsConsoleService` (TS-224).
 *
 * `FakePrisma` is an in-memory store implementing the narrow
 * `conciergeTicket` + `conciergeTicketNote` surface the service consumes
 * (`findMany`, `findFirst`, `update`, `create`) plus a `$transaction`
 * callback that runs against the same store. There is no real transactional
 * rollback — the integration test against a real Postgres carries the atomic
 * guarantee + the FK / cascade behaviour.
 */

interface TicketSeed extends ConciergeTicketRow {
  readonly deletedAt: Date | null;
}

let noteCounter = 0;

class FakePrisma {
  public tickets: TicketSeed[] = [];
  public notes: (ConciergeTicketNoteRow & { householdId: string })[] = [];

  private get ticketDelegate(): {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      take?: number;
      select?: Record<string, boolean>;
    }) => Promise<TicketSeed[]>;
    findFirst: (args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<TicketSeed | null>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<TicketSeed>;
  } {
    return {
      findMany: async (args) => {
        let result = this.tickets.filter((t) => matchesWhere(t, args.where));
        if (args.orderBy !== undefined) {
          result = [...result].sort((a, b) => compareByClauses(a, b, args.orderBy ?? []));
        }
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result;
      },
      findFirst: async (args) => this.tickets.find((t) => matchesWhere(t, args.where)) ?? null,
      update: async (args) => {
        const row = this.tickets.find((t) => t.id === args.where.id);
        if (row === undefined) throw new Error(`ticket ${args.where.id} not found`);
        Object.assign(row, args.data, { updatedAt: new Date('2026-06-02T00:00:00.000Z') });
        return row;
      },
    };
  }

  private get noteDelegate(): {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      take?: number;
      select?: Record<string, boolean>;
    }) => Promise<ConciergeTicketNoteRow[]>;
    create: (args: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }) => Promise<ConciergeTicketNoteRow>;
  } {
    return {
      findMany: async (args) => {
        let result = this.notes.filter((n) => matchesWhere(n, args.where));
        if (args.orderBy !== undefined) {
          result = [...result].sort((a, b) => compareByClauses(a, b, args.orderBy ?? []));
        }
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result;
      },
      create: async (args) => {
        noteCounter += 1;
        const row = {
          id: `note_${noteCounter}`,
          ticketId: String(args.data['ticketId']),
          householdId: String(args.data['householdId']),
          authorUserId: String(args.data['authorUserId']),
          body: String(args.data['body']),
          createdAt: new Date(`2026-06-02T00:00:0${noteCounter % 10}.000Z`),
        };
        this.notes.push(row);
        return row;
      },
    };
  }

  public get conciergeTicket(): ReturnType<() => FakePrisma['ticketDelegate']> {
    return this.ticketDelegate;
  }

  public get conciergeTicketNote(): ReturnType<() => FakePrisma['noteDelegate']> {
    return this.noteDelegate;
  }

  public async $transaction<T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return cb(this);
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
    if (expected !== null && typeof expected === 'object' && 'in' in (expected as object)) {
      const list = (expected as { in: readonly unknown[] }).in;
      if (!list.includes(actual)) return false;
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
  // NULLs sort last under ASC (Postgres default the service relies on).
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  return 0;
}

function ticket(overrides: Partial<TicketSeed> = {}): TicketSeed {
  return {
    id: 'tk_1',
    householdId: 'hh_1',
    kind: 'holiday_dinner',
    status: 'open',
    subject: 'Thanksgiving supper',
    body: 'Small traditional turkey dinner.',
    requestedDate: null,
    partySize: null,
    theme: null,
    slaDueAt: new Date('2026-06-05T00:00:00.000Z'),
    assignedToUserId: null,
    escalationPath: 'standard',
    createdAt: new Date('2026-06-01T09:00:00.000Z'),
    updatedAt: new Date('2026-06-01T09:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function makeService(fake: FakePrisma): OpsConsoleService {
  return new OpsConsoleService(fake as unknown as PrismaService);
}

describe('OpsConsoleService.listQueue', () => {
  it('defaults to non-terminal tickets, ordered by SLA proximity', async () => {
    const fake = new FakePrisma();
    fake.tickets = [
      ticket({ id: 'tk_soon', slaDueAt: new Date('2026-06-02T00:00:00.000Z') }),
      ticket({ id: 'tk_later', slaDueAt: new Date('2026-06-09T00:00:00.000Z') }),
      ticket({ id: 'tk_resolved', status: 'resolved' }),
      ticket({ id: 'tk_canceled', status: 'canceled' }),
    ];
    const result = await makeService(fake).listQueue({ limit: 50 });
    expect(result.map((t) => t.id)).toEqual(['tk_soon', 'tk_later']);
  });

  it('places tickets with no SLA last', async () => {
    const fake = new FakePrisma();
    fake.tickets = [
      ticket({ id: 'tk_no_sla', slaDueAt: null }),
      ticket({ id: 'tk_sla', slaDueAt: new Date('2026-06-03T00:00:00.000Z') }),
    ];
    const result = await makeService(fake).listQueue({ limit: 50 });
    expect(result.map((t) => t.id)).toEqual(['tk_sla', 'tk_no_sla']);
  });

  it('filters by an explicit status (including terminal for review)', async () => {
    const fake = new FakePrisma();
    fake.tickets = [
      ticket({ id: 'tk_open', status: 'open' }),
      ticket({ id: 'tk_resolved', status: 'resolved' }),
    ];
    const result = await makeService(fake).listQueue({ status: 'resolved', limit: 50 });
    expect(result.map((t) => t.id)).toEqual(['tk_resolved']);
  });

  it('filters by escalationPath / kind / householdId', async () => {
    const fake = new FakePrisma();
    fake.tickets = [
      ticket({
        id: 'tk_a',
        householdId: 'hh_1',
        kind: 'holiday_dinner',
        escalationPath: 'standard',
      }),
      ticket({
        id: 'tk_b',
        householdId: 'hh_2',
        kind: 'memory_meal',
        status: 'escalated',
        escalationPath: 'trust_safety',
      }),
    ];
    expect(
      (await makeService(fake).listQueue({ escalationPath: 'trust_safety', limit: 50 })).map(
        (t) => t.id,
      ),
    ).toEqual(['tk_b']);
    expect(
      (await makeService(fake).listQueue({ kind: 'memory_meal', limit: 50 })).map((t) => t.id),
    ).toEqual(['tk_b']);
    expect(
      (await makeService(fake).listQueue({ householdId: 'hh_1', limit: 50 })).map((t) => t.id),
    ).toEqual(['tk_a']);
  });

  it('excludes soft-deleted tickets and honours the limit', async () => {
    const fake = new FakePrisma();
    fake.tickets = [
      ticket({ id: 'tk_live', slaDueAt: new Date('2026-06-02T00:00:00.000Z') }),
      ticket({
        id: 'tk_deleted',
        slaDueAt: new Date('2026-06-01T00:00:00.000Z'),
        deletedAt: new Date('2026-06-01T10:00:00.000Z'),
      }),
      ticket({ id: 'tk_b', slaDueAt: new Date('2026-06-03T00:00:00.000Z') }),
    ];
    const all = await makeService(fake).listQueue({ limit: 50 });
    expect(all.map((t) => t.id)).toEqual(['tk_live', 'tk_b']);
    const limited = await makeService(fake).listQueue({ limit: 1 });
    expect(limited.map((t) => t.id)).toEqual(['tk_live']);
  });
});

describe('OpsConsoleService.getTicketDetail', () => {
  it('returns the ticket + notes oldest-first', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1' })];
    fake.notes = [
      {
        id: 'note_2',
        ticketId: 'tk_1',
        householdId: 'hh_1',
        authorUserId: 'user_ops',
        body: 'Second',
        createdAt: new Date('2026-06-02T00:00:02.000Z'),
      },
      {
        id: 'note_1',
        ticketId: 'tk_1',
        householdId: 'hh_1',
        authorUserId: 'user_ops',
        body: 'First',
        createdAt: new Date('2026-06-02T00:00:01.000Z'),
      },
    ];
    const detail = await makeService(fake).getTicketDetail('tk_1');
    expect(detail).not.toBeNull();
    expect(detail?.ticket.id).toBe('tk_1');
    expect(detail?.notes.map((n) => n.body)).toEqual(['First', 'Second']);
    // Wire shape never leaks the denormalised householdId on the note.
    expect(detail?.notes[0]).not.toHaveProperty('householdId');
  });

  it('returns null for a missing ticket', async () => {
    const fake = new FakePrisma();
    expect(await makeService(fake).getTicketDetail('nope')).toBeNull();
  });

  it('returns null for a soft-deleted ticket', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', deletedAt: new Date('2026-06-01T10:00:00.000Z') })];
    expect(await makeService(fake).getTicketDetail('tk_1')).toBeNull();
  });
});

describe('OpsConsoleService.transition', () => {
  it('applies a valid transition', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', status: 'open' })];
    const outcome = await makeService(fake).transition({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      targetStatus: 'in_progress',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.ticket.status).toBe('in_progress');
    expect(fake.tickets[0]?.status).toBe('in_progress');
    expect(fake.notes).toHaveLength(0);
  });

  it('appends a note when one is supplied (same transaction)', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', status: 'in_progress' })];
    const outcome = await makeService(fake).transition({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      targetStatus: 'resolved',
      note: 'Family was delighted.',
    });
    expect(outcome.ok).toBe(true);
    expect(fake.notes).toHaveLength(1);
    expect(fake.notes[0]?.body).toBe('Family was delighted.');
    expect(fake.notes[0]?.authorUserId).toBe('user_ops');
    expect(fake.notes[0]?.householdId).toBe('hh_1');
  });

  it('rejects a disallowed transition with invalid_transition', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', status: 'open' })];
    const outcome = await makeService(fake).transition({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      targetStatus: 'resolved',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'invalid_transition') {
      expect(outcome.from).toBe('open');
      expect(outcome.to).toBe('resolved');
    } else {
      throw new Error('expected invalid_transition');
    }
    // No write happened.
    expect(fake.tickets[0]?.status).toBe('open');
  });

  it('returns not_found for a missing / soft-deleted ticket', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', deletedAt: new Date('2026-06-01T10:00:00.000Z') })];
    const missing = await makeService(fake).transition({
      ticketId: 'nope',
      actorUserId: 'user_ops',
      targetStatus: 'in_progress',
    });
    expect(missing.ok).toBe(false);
    const deleted = await makeService(fake).transition({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      targetStatus: 'in_progress',
    });
    expect(deleted.ok).toBe(false);
  });
});

describe('OpsConsoleService.escalate', () => {
  it('sets the escalation path + moves to escalated', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', status: 'in_progress', escalationPath: 'standard' })];
    const outcome = await makeService(fake).escalate({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      escalationPath: 'trust_safety',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.ticket.status).toBe('escalated');
      expect(outcome.ticket.escalationPath).toBe('trust_safety');
    }
  });

  it('re-escalates an already-escalated ticket to a different path', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', status: 'escalated', escalationPath: 'concierge_lead' })];
    const outcome = await makeService(fake).escalate({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      escalationPath: 'ops_manager',
      note: 'Lead is OOO; bumping to ops.',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.ticket.escalationPath).toBe('ops_manager');
    expect(fake.notes).toHaveLength(1);
  });

  it('rejects escalating a terminal ticket', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', status: 'resolved' })];
    const outcome = await makeService(fake).escalate({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      escalationPath: 'ops_manager',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'terminal') {
      expect(outcome.status).toBe('resolved');
    } else {
      throw new Error('expected terminal');
    }
  });

  it('returns not_found for a missing ticket', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).escalate({
      ticketId: 'nope',
      actorUserId: 'user_ops',
      escalationPath: 'ops_manager',
    });
    expect(outcome.ok).toBe(false);
  });
});

describe('OpsConsoleService.addNote', () => {
  it('appends a note carrying the actor + the ticket household', async () => {
    const fake = new FakePrisma();
    fake.tickets = [ticket({ id: 'tk_1', householdId: 'hh_42' })];
    const outcome = await makeService(fake).addNote({
      ticketId: 'tk_1',
      actorUserId: 'user_ops',
      body: 'Confirmed the guest count with the chef.',
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.note.authorUserId).toBe('user_ops');
      expect(outcome.note.ticketId).toBe('tk_1');
      expect(outcome.note).not.toHaveProperty('householdId');
    }
    expect(fake.notes[0]?.householdId).toBe('hh_42');
  });

  it('returns not_found for a missing ticket', async () => {
    const fake = new FakePrisma();
    const outcome = await makeService(fake).addNote({
      ticketId: 'nope',
      actorUserId: 'user_ops',
      body: 'orphan note',
    });
    expect(outcome.ok).toBe(false);
  });
});
