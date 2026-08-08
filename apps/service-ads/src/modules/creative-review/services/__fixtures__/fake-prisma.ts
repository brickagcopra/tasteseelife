/**
 * In-memory Prisma fake for the creative-review repository + service unit tests
 * (TS-277a). Implements the narrow surface `CreativeReviewRepository` consumes —
 * `adCreative.findUnique` / `findMany` / `update`, `adCampaign.findUnique` /
 * `findMany`, `adCreativeReview.findMany` / `create`, and `$transaction`. The
 * real FK / cascade behaviour + transactional guarantees are covered by the
 * Testcontainers integration test (TS-277a-followup); this fake pins the
 * repository's wiring. Excluded from the build + coverage globs (it lives under
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
    if (expected !== null && typeof expected === 'object' && 'in' in (expected as Row)) {
      const list = (expected as { in: unknown[] }).in;
      if (!list.includes(row[key])) return false;
      continue;
    }
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
 * `createdAt` — keeps ordering deterministic without the forbidden `Date.now()`.
 */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 15, 0, 0, tick));
}

export class FakeReviewPrisma {
  creatives: Row[] = [];
  campaigns: Row[] = [];
  reviews: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** Seed a creative row with sensible accessibility-column defaults. */
  addCreative(row: Partial<Row> & { id: string; campaignId: string; kind: string }): Row {
    const now = nextDate();
    const full: Row = {
      assetKeys: [],
      headline: 'A warm chef-prepared meal',
      body: null,
      ctaUrl: null,
      status: 'pending_review',
      altText: null,
      textColor: null,
      backgroundColor: null,
      motionSafe: true,
      disclosureAcknowledged: false,
      createdAt: now,
      updatedAt: now,
      ...row,
    };
    this.creatives.push(full);
    return full;
  }

  /** Seed a campaign context row. */
  addCampaign(row: Partial<Row> & { id: string }): Row {
    const now = nextDate();
    const full: Row = {
      name: 'House upgrade nudge',
      advertiserKind: 'internal',
      createdAt: now,
      updatedAt: now,
      ...row,
    };
    this.campaigns.push(full);
    return full;
  }

  readonly adCreative = {
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => this.creatives.find((r) => r['id'] === args.where.id) ?? null,

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.creatives.filter((r) => matchesWhere(r, args.where));
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
      const row = this.creatives.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`creative ${args.where.id} not found`);
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

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.campaigns.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      return result;
    },
  };

  readonly adCreativeReview = {
    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.reviews.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      return result;
    },

    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('rev'),
        notes: null,
        overrodeAccessibility: false,
        ...args.data,
        createdAt: now,
      };
      this.reviews.push(row);
      return row;
    },
  };

  /** Fake `$transaction` — invokes the callback with `this` as the tx client. */
  readonly $transaction = async <T>(cb: (tx: FakeReviewPrisma) => Promise<T>): Promise<T> =>
    cb(this);
}
