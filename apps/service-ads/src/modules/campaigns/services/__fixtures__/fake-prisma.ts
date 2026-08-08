/**
 * In-memory Prisma fake for the campaign-aggregate repository unit tests
 * (TS-271a). Implements the narrow surface `CampaignRepository` consumes —
 * `$transaction`, plus `create` (with nested `creatives` / `targetingRules`),
 * `findUnique` / `findFirst` / `findMany` / `update` across `adCampaign` /
 * `adCreative` / `adTargetingRule`. The real FK / cascade behaviour +
 * transactional guarantees are covered by the Testcontainers integration test
 * (TS-271a-followup); this fake pins the repository's wiring. Excluded from the
 * build + coverage globs (it lives under `__fixtures__/`).
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
 * `createdAt` — keeps `orderBy: createdAt asc` deterministic without relying on
 * the forbidden `Date.now()` (CLAUDE.md / the workflow-script clock rule). The
 * base instant is fixed.
 */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 13, 0, 0, tick));
}

export class FakeAdsPrisma {
  campaigns: Row[] = [];
  creatives: Row[] = [];
  rules: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  readonly adCampaign = {
    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const id = this.id('camp');
      const { creatives, targetingRules, ...scalars } = args.data;
      const row: Row = {
        id,
        advertiserId: null,
        budget: null,
        currency: 'USD',
        startAt: null,
        endAt: null,
        status: 'draft',
        ...scalars,
        createdAt: now,
        updatedAt: now,
      };
      this.campaigns.push(row);
      const nested = creatives as { create?: Row[] } | undefined;
      for (const c of nested?.create ?? []) {
        const cNow = nextDate();
        this.creatives.push({
          id: this.id('crea'),
          campaignId: id,
          assetKeys: [],
          body: null,
          ctaUrl: null,
          status: 'draft',
          ...c,
          createdAt: cNow,
          updatedAt: cNow,
        });
      }
      const nestedRules = targetingRules as { create?: Row[] } | undefined;
      for (const r of nestedRules?.create ?? []) {
        const rNow = nextDate();
        this.rules.push({
          id: this.id('rule'),
          campaignId: id,
          ...r,
          createdAt: rNow,
          updatedAt: rNow,
        });
      }
      return row;
    },

    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => this.campaigns.find((r) => r['id'] === args.where.id) ?? null,

    findFirst: async (args: FindManyArgs = {}): Promise<Row | null> => {
      let result = this.campaigns.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      return result[0] ?? null;
    },

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.campaigns.filter((r) => matchesWhere(r, args.where));
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
      const row = this.campaigns.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`campaign ${args.where.id} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  readonly adCreative = {
    findFirst: async (args: FindManyArgs = {}): Promise<Row | null> =>
      this.creatives.find((r) => matchesWhere(r, args.where)) ?? null,

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.creatives.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
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

  readonly adTargetingRule = {
    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.rules.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      return result;
    },
  };

  /** Fake `$transaction` — invokes the callback with `this` as the tx client. */
  readonly $transaction = async <T>(cb: (tx: FakeAdsPrisma) => Promise<T>): Promise<T> => cb(this);
}
