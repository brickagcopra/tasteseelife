import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { AssignmentsService, type ConciergeAssignmentRow } from './assignments.service';

/**
 * Unit tests for `AssignmentsService` (TS-222).
 *
 * `FakePrisma` is an in-memory store implementing the narrow
 * `conciergeAssignment` surface the service consumes (`findFirst`,
 * `findMany`, `updateMany`, `create`, `update`) plus a `$transaction`
 * callback that runs against the same store. There is no real
 * transactional rollback — the integration test against a real Postgres
 * carries the atomic guarantee + the partial-unique-index enforcement.
 */

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
  readonly orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
  readonly take?: number;
  readonly select?: Record<string, boolean>;
}
interface UpdateManyArgs {
  readonly where: Record<string, unknown>;
  readonly data: Record<string, unknown>;
}
interface UpdateArgs {
  readonly where: { id: string };
  readonly data: Record<string, unknown>;
  readonly select?: Record<string, boolean>;
}

let idCounter = 0;

class FakePrisma {
  public rows: ConciergeAssignmentRow[] = [];
  /** When set, the next `create` throws a Prisma P2002 unique violation. */
  public failNextCreateWithUnique = false;

  private get delegate(): {
    findFirst: (args: FindFirstArgs) => Promise<ConciergeAssignmentRow | null>;
    findMany: (args: FindManyArgs) => Promise<ConciergeAssignmentRow[]>;
    updateMany: (args: UpdateManyArgs) => Promise<{ count: number }>;
    create: (args: CreateArgs) => Promise<ConciergeAssignmentRow>;
    update: (args: UpdateArgs) => Promise<ConciergeAssignmentRow>;
  } {
    return {
      findFirst: async (args) => {
        const match = this.rows.find((r) => matches(r, args.where));
        return match ?? null;
      },
      findMany: async (args) => {
        let result = this.rows.filter((r) => matches(r, args.where));
        for (const clause of [...(args.orderBy ?? [])].reverse()) {
          const entry = Object.entries(clause)[0];
          if (entry === undefined) continue;
          const [key, dir] = entry;
          result = [...result].sort((a, b) => compareBy(a, b, key, dir));
        }
        if (typeof args.take === 'number') result = result.slice(0, args.take);
        return result;
      },
      updateMany: async (args) => {
        let count = 0;
        for (const row of this.rows) {
          if (!matches(row, args.where)) continue;
          Object.assign(row, args.data);
          count += 1;
        }
        return { count };
      },
      create: async (args) => {
        if (this.failNextCreateWithUnique) {
          this.failNextCreateWithUnique = false;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        idCounter += 1;
        const now = new Date('2026-06-01T09:00:00.000Z');
        const data = args.data;
        const row: ConciergeAssignmentRow = {
          id: `ca_${idCounter}`,
          householdId: String(data['householdId']),
          primaryConciergeUserId: String(data['primaryConciergeUserId']),
          primaryConciergeDisplayName: String(data['primaryConciergeDisplayName']),
          backupConciergeUserId: (data['backupConciergeUserId'] as string | null) ?? null,
          backupConciergeDisplayName: (data['backupConciergeDisplayName'] as string | null) ?? null,
          status: (data['status'] as 'active' | 'ended') ?? 'active',
          assignedByUserId: (data['assignedByUserId'] as string | null) ?? null,
          startedAt: (data['startedAt'] as Date) ?? now,
          endedAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        this.rows.push(row);
        return row;
      },
      update: async (args) => {
        const row = this.rows.find((r) => r.id === args.where.id);
        if (row === undefined) throw new Error('not found');
        Object.assign(row, args.data);
        return row;
      },
    };
  }

  get conciergeAssignment(): FakePrisma['delegate'] {
    return this.delegate;
  }

  async $transaction<T>(
    cb: (tx: { conciergeAssignment: FakePrisma['delegate'] }) => Promise<T>,
  ): Promise<T> {
    return cb({ conciergeAssignment: this.delegate });
  }
}

function matches(row: ConciergeAssignmentRow, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if ((row as unknown as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}

function compareBy(
  a: ConciergeAssignmentRow,
  b: ConciergeAssignmentRow,
  key: string,
  dir: 'asc' | 'desc',
): number {
  const av = (a as unknown as Record<string, unknown>)[key];
  const bv = (b as unknown as Record<string, unknown>)[key];
  const an = av instanceof Date ? av.getTime() : String(av);
  const bn = bv instanceof Date ? bv.getTime() : String(bv);
  const cmp = an < bn ? -1 : an > bn ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

function buildService(prisma: FakePrisma): AssignmentsService {
  return new AssignmentsService(prisma as unknown as PrismaService);
}

const PRIMARY = {
  householdId: 'hh_1',
  primaryConciergeUserId: 'user_primary',
  primaryConciergeDisplayName: 'Avery Concierge',
  backupConciergeUserId: null,
  backupConciergeDisplayName: null,
  assignedByUserId: 'user_admin',
} as const;

describe('AssignmentsService.create', () => {
  it('inserts an active assignment and returns the wire record', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const result = await service.create({ ...PRIMARY });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('active');
      expect(result.value.primaryConciergeDisplayName).toBe('Avery Concierge');
      expect(result.value.assignedByUserId).toBe('user_admin');
      expect(result.value.endedAt).toBeNull();
      // ISO string projection, not a Date.
      expect(typeof result.value.startedAt).toBe('string');
    }
    expect(prisma.rows).toHaveLength(1);
  });

  it('persists a backup concierge when supplied', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const result = await service.create({
      ...PRIMARY,
      backupConciergeUserId: 'user_backup',
      backupConciergeDisplayName: 'Blair Backup',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.backupConciergeUserId).toBe('user_backup');
      expect(result.value.backupConciergeDisplayName).toBe('Blair Backup');
    }
  });

  it('ends the prior active assignment when reassigning (history preserved)', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    const first = await service.create({ ...PRIMARY });
    const second = await service.create({
      ...PRIMARY,
      primaryConciergeUserId: 'user_new',
      primaryConciergeDisplayName: 'Casey New',
    });

    expect(first.ok && second.ok).toBe(true);
    // Two rows total — the prior is ended, the new is active.
    expect(prisma.rows).toHaveLength(2);
    const ended = prisma.rows.filter((r) => r.status === 'ended');
    const active = prisma.rows.filter((r) => r.status === 'active');
    expect(ended).toHaveLength(1);
    expect(active).toHaveLength(1);
    expect(ended[0]?.endedAt).not.toBeNull();
    expect(active[0]?.primaryConciergeUserId).toBe('user_new');
  });

  it('returns a conflict failure on the single-active create race (P2002)', async () => {
    const prisma = new FakePrisma();
    prisma.failNextCreateWithUnique = true;
    const service = buildService(prisma);

    const result = await service.create({ ...PRIMARY });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('conflict');
    }
  });
});

describe('AssignmentsService.getActiveForHousehold', () => {
  it('returns the active assignment for the household', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.create({ ...PRIMARY });

    const active = await service.getActiveForHousehold('hh_1');

    expect(active).not.toBeNull();
    expect(active?.status).toBe('active');
  });

  it('returns null when the household has no active assignment', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    expect(await service.getActiveForHousehold('hh_unknown')).toBeNull();
  });

  it('ignores ended + soft-deleted rows', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.create({ ...PRIMARY });
    await service.endAssignment(prisma.rows[0]!.id);

    expect(await service.getActiveForHousehold('hh_1')).toBeNull();
  });
});

describe('AssignmentsService.listForHousehold', () => {
  it('returns history active-first then by recency', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.create({ ...PRIMARY });
    await service.create({
      ...PRIMARY,
      primaryConciergeUserId: 'user_new',
      primaryConciergeDisplayName: 'Casey New',
    });

    const list = await service.listForHousehold({
      householdId: 'hh_1',
      activeOnly: false,
      limit: 50,
    });

    expect(list).toHaveLength(2);
    expect(list[0]?.status).toBe('active');
    expect(list[1]?.status).toBe('ended');
  });

  it('restricts to the active row when activeOnly is set', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.create({ ...PRIMARY });
    await service.create({
      ...PRIMARY,
      primaryConciergeUserId: 'user_new',
      primaryConciergeDisplayName: 'Casey New',
    });

    const list = await service.listForHousehold({
      householdId: 'hh_1',
      activeOnly: true,
      limit: 50,
    });

    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe('active');
  });

  it('returns an empty array for a household with no assignments', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    expect(
      await service.listForHousehold({ householdId: 'hh_none', activeOnly: false, limit: 50 }),
    ).toEqual([]);
  });
});

describe('AssignmentsService.endAssignment', () => {
  it('ends an active assignment', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.create({ ...PRIMARY });
    const id = prisma.rows[0]!.id;

    expect(await service.endAssignment(id)).toBe('ended');
    expect(prisma.rows[0]?.status).toBe('ended');
    expect(prisma.rows[0]?.endedAt).not.toBeNull();
  });

  it('is idempotent — ending an already-ended row returns already_ended', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);
    await service.create({ ...PRIMARY });
    const id = prisma.rows[0]!.id;
    await service.endAssignment(id);

    expect(await service.endAssignment(id)).toBe('already_ended');
  });

  it('returns not_found for an unknown id', async () => {
    const prisma = new FakePrisma();
    const service = buildService(prisma);

    expect(await service.endAssignment('ca_missing')).toBe('not_found');
  });
});
