/**
 * In-memory Prisma fake for the help-category repository unit tests
 * (TS-284-followup-3). Implements the narrow surface `HelpCategoryRepository`
 * consumes — `$transaction`, plus
 * `helpCategory.{create,findUnique,findMany,update}`. Excluded from the build +
 * coverage globs (lives under `__fixtures__/`). Mirrors the pages / articles
 * fakes.
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

/** Monotonic clock — strictly-increasing timestamps without `Date.now()`. */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 30, 0, 0, tick));
}

export class FakeHelpCategoryPrisma {
  categories: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  readonly helpCategory = {
    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('cat'),
        parentId: null,
        sortOrder: 0,
        ...args.data,
        createdAt: now,
        updatedAt: now,
      };
      this.categories.push(row);
      return row;
    },

    findUnique: async (args: {
      where: { id?: string; slug?: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => {
      if (args.where.id !== undefined)
        return this.categories.find((r) => r['id'] === args.where.id) ?? null;
      if (args.where.slug !== undefined)
        return this.categories.find((r) => r['slug'] === args.where.slug) ?? null;
      return null;
    },

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.categories.filter((r) => matchesWhere(r, args.where));
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
      const row = this.categories.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`category ${args.where.id} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  /** Fake `$transaction` — invokes the callback with `this` as the tx client. */
  readonly $transaction = async <T>(cb: (tx: FakeHelpCategoryPrisma) => Promise<T>): Promise<T> =>
    cb(this);
}
