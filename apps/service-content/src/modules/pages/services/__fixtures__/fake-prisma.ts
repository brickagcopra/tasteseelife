/**
 * In-memory Prisma fake for the static-pages repository unit tests (TS-284).
 * Implements the narrow surface `PageRepository` consumes — `$transaction`,
 * plus `page.{create,findUnique,findMany,update}` and
 * `pageVersion.{create,findFirst,findMany,update}`. The real FK / cascade
 * behaviour + transactional guarantees are covered by the Testcontainers
 * integration test (TS-284-followup); this fake pins the repository's wiring.
 * Excluded from the build + coverage globs (it lives under `__fixtures__/`).
 * Mirrors the service-ads `FakeAdsPrisma` shape.
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
 * `createdAt` — keeps `orderBy: createdAt` deterministic without relying on the
 * forbidden `Date.now()` (CLAUDE.md / the workflow-script clock rule). The base
 * instant is fixed.
 */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 30, 0, 0, tick));
}

export class FakeContentPrisma {
  pages: Row[] = [];
  versions: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  readonly page = {
    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('page'),
        status: 'draft',
        currentVersionId: null,
        ...args.data,
        createdAt: now,
        updatedAt: now,
      };
      this.pages.push(row);
      return row;
    },

    findUnique: async (args: {
      where: { id?: string; slug?: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => {
      if (args.where.id !== undefined)
        return this.pages.find((r) => r['id'] === args.where.id) ?? null;
      if (args.where.slug !== undefined)
        return this.pages.find((r) => r['slug'] === args.where.slug) ?? null;
      return null;
    },

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.pages.filter((r) => matchesWhere(r, args.where));
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
      const row = this.pages.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`page ${args.where.id} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  readonly pageVersion = {
    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('ver'),
        effectiveAt: null,
        isMaterialChange: false,
        materialChangeNote: null,
        ...args.data,
        createdAt: now,
        updatedAt: now,
      };
      this.versions.push(row);
      return row;
    },

    findFirst: async (args: FindManyArgs = {}): Promise<Row | null> => {
      let result = this.versions.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      return result[0] ?? null;
    },

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.versions.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      return result;
    },

    update: async (args: {
      where: { id: string };
      data: Row;
      select?: Record<string, boolean>;
    }): Promise<Row> => {
      const row = this.versions.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`version ${args.where.id} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  /** Fake `$transaction` — invokes the callback with `this` as the tx client. */
  readonly $transaction = async <T>(cb: (tx: FakeContentPrisma) => Promise<T>): Promise<T> =>
    cb(this);
}
