/**
 * In-memory Prisma fake for the slot-inventory repository + service unit tests
 * (TS-272a). Implements the narrow surface `SlotInventoryRepository` consumes —
 * `adPlacement` (findUnique / findMany / create / update), `adSlotSchedule`
 * (create / findUnique / findMany / update), `adCampaign.findUnique` (the
 * create-time existence check), and `adCreative.findMany` (the approved-kind
 * compatibility read, TS-272a-followup-3). The real FK / cascade behaviour is
 * covered by the Testcontainers integration test (TS-272a-followup); this fake
 * pins the wiring. Excluded from the build + coverage globs (it lives under
 * `__fixtures__/`).
 */

type Row = Record<string, unknown>;

interface FindManyArgs {
  where?: Row;
  orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>> | Record<string, 'asc' | 'desc'>;
  take?: number;
  select?: Record<string, boolean>;
}

function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (row[key] !== expected) return false;
  }
  return true;
}

function compare(a: Row, b: Row, orderBy: FindManyArgs['orderBy']): number {
  const clauses = orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const clause of clauses) {
    const [field, dir] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
    const av = a[field];
    const bv = b[field];
    let cmp = 0;
    if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
    else if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

/**
 * A monotonic clock so each generated row gets a strictly-increasing
 * `createdAt` — keeps `orderBy: createdAt` deterministic without the forbidden
 * `Date.now()` (CLAUDE.md / the workflow-script clock rule).
 */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 15, 0, 0, tick));
}

export class FakeSlotPrisma {
  placements: Row[] = [];
  schedules: Row[] = [];
  campaigns: Row[] = [];
  creatives: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** Seed a placement directly (test setup helper, not a Prisma method). */
  seedPlacement(slotCode: string, supportedCreativeKinds: string[]): string {
    const now = nextDate();
    const id = this.id('plc');
    this.placements.push({ id, slotCode, supportedCreativeKinds, createdAt: now, updatedAt: now });
    return id;
  }

  /**
   * Seed a campaign directly (test setup helper). Pass `creatives` to attach
   * creatives (exercising the TS-272a-followup-3 approved-kind compatibility
   * read); omit for a creative-less campaign.
   */
  seedCampaign(creatives: ReadonlyArray<{ kind: string; status: string }> = []): string {
    const now = nextDate();
    const id = this.id('camp');
    this.campaigns.push({ id, createdAt: now, updatedAt: now });
    for (const c of creatives) {
      this.creatives.push({
        id: this.id('cre'),
        campaignId: id,
        kind: c.kind,
        status: c.status,
        createdAt: nextDate(),
        updatedAt: now,
      });
    }
    return id;
  }

  readonly adPlacement = {
    findUnique: async (args: {
      where: { id?: string; slotCode?: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> =>
      this.placements.find(
        (r) =>
          (args.where.id !== undefined && r['id'] === args.where.id) ||
          (args.where.slotCode !== undefined && r['slotCode'] === args.where.slotCode),
      ) ?? null,

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.placements.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      if (typeof args.take === 'number') result = result.slice(0, args.take);
      return result;
    },

    create: async (args: { data: Row }): Promise<Row> => {
      const now = nextDate();
      const row: Row = { id: this.id('plc'), ...args.data, createdAt: now, updatedAt: now };
      this.placements.push(row);
      return row;
    },

    update: async (args: { where: { slotCode: string }; data: Row }): Promise<Row> => {
      const row = this.placements.find((r) => r['slotCode'] === args.where.slotCode);
      if (row === undefined) throw new Error(`placement ${args.where.slotCode} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  readonly adCampaign = {
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => this.campaigns.find((r) => r['id'] === args.where.id) ?? null,
  };

  readonly adCreative = {
    findMany: async (args: FindManyArgs = {}): Promise<Row[]> =>
      this.creatives.filter((r) => matchesWhere(r, args.where)),
  };

  readonly adSlotSchedule = {
    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('sch'),
        status: 'scheduled',
        priority: 0,
        endAt: null,
        ...args.data,
        createdAt: now,
        updatedAt: now,
      };
      this.schedules.push(row);
      return row;
    },

    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => this.schedules.find((r) => r['id'] === args.where.id) ?? null,

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.schedules.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      if (typeof args.take === 'number') result = result.slice(0, args.take);
      return result;
    },

    update: async (args: {
      where: { id: string };
      data: Row;
      select?: Record<string, boolean>;
    }): Promise<Row> => {
      const row = this.schedules.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`schedule ${args.where.id} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  /** Fake `$transaction` — invokes the callback with `this` as the tx client. */
  readonly $transaction = async <T>(cb: (tx: FakeSlotPrisma) => Promise<T>): Promise<T> => cb(this);
}
