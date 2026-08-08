/**
 * Shared in-memory Prisma fake for the catalog service unit tests (TS-251).
 *
 * Implements the narrow surface the four catalog services consume —
 * `findFirst` / `findMany` / `create` / `update` / `count` / `delete` across
 * `academyCourse` / `academyCourseModule` / `academyLesson` / `academyCohort`.
 * The real FK / cascade behaviour + transactional guarantees are covered by the
 * Testcontainers integration test (TS-251-followup); this fake pins the
 * services' branching logic. Excluded from the build + coverage globs (it lives
 * under `__fixtures__/`).
 */

type Row = Record<string, unknown>;

interface FindManyArgs {
  where?: Row;
  orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>> | Record<string, 'asc' | 'desc'>;
  take?: number;
  select?: Record<string, boolean>;
}

interface FindFirstArgs {
  where?: Row;
  orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>> | Record<string, 'asc' | 'desc'>;
  select?: Record<string, boolean>;
}

interface CreateArgs {
  data: Row;
  select?: Record<string, boolean>;
}

interface UpdateArgs {
  where: { id: string };
  data: Row;
  select?: Record<string, boolean>;
}

const FIXED_CREATED = new Date('2026-06-01T00:00:00.000Z');
const FIXED_UPDATED = new Date('2026-06-02T00:00:00.000Z');

/** Whether `row` matches a (flat, AND-combined) Prisma `where` clause. */
function matchesWhere(row: Row, where: Row | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, expected] of Object.entries(where)) {
    const actual = row[key];
    if (expected !== null && typeof expected === 'object' && 'in' in (expected as Row)) {
      const list = (expected as { in: unknown[] }).in;
      if (!list.includes(actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
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
 * One in-memory table. `idPrefix` seeds generated ids; `defaults` are merged
 * under the create `data` (so a soft-delete column or status default lands
 * even when the caller omits it — the services always pass explicit values, so
 * `defaults` mainly supplies `deletedAt: null` + timestamps).
 */
export class FakeTable<T extends Row> {
  public rows: T[] = [];
  private counter = 0;

  constructor(
    private readonly idPrefix: string,
    private readonly defaults: Row = {},
  ) {}

  /** Seed a fully-formed row directly (test setup). */
  seed(row: T): T {
    this.rows.push(row);
    return row;
  }

  readonly findMany = async (args: FindManyArgs = {}): Promise<T[]> => {
    let result = this.rows.filter((r) => matchesWhere(r, args.where));
    if (args.orderBy !== undefined) {
      result = [...result].sort((a, b) => compare(a, b, args.orderBy));
    }
    if (typeof args.take === 'number') result = result.slice(0, args.take);
    return result;
  };

  readonly findFirst = async (args: FindFirstArgs = {}): Promise<T | null> => {
    let result = this.rows.filter((r) => matchesWhere(r, args.where));
    if (args.orderBy !== undefined) {
      result = [...result].sort((a, b) => compare(a, b, args.orderBy));
    }
    return result[0] ?? null;
  };

  readonly create = async (args: CreateArgs): Promise<T> => {
    this.counter += 1;
    const row = {
      id: `${this.idPrefix}_${this.counter}`,
      createdAt: FIXED_CREATED,
      updatedAt: FIXED_CREATED,
      ...this.defaults,
      ...args.data,
    } as unknown as T;
    this.rows.push(row);
    return row;
  };

  readonly update = async (args: UpdateArgs): Promise<T> => {
    const row = this.rows.find((r) => (r as Row)['id'] === args.where.id);
    if (row === undefined) throw new Error(`${this.idPrefix} ${args.where.id} not found`);
    applyUpdate(row as Row, args.data);
    (row as Row)['updatedAt'] = FIXED_UPDATED;
    return row;
  };

  readonly count = async (args: { where?: Row } = {}): Promise<number> => {
    return this.rows.filter((r) => matchesWhere(r, args.where)).length;
  };

  readonly delete = async (args: { where: { id: string } }): Promise<T> => {
    const idx = this.rows.findIndex((r) => (r as Row)['id'] === args.where.id);
    if (idx === -1) throw new Error(`${this.idPrefix} ${args.where.id} not found`);
    const [removed] = this.rows.splice(idx, 1);
    return removed as T;
  };

  readonly deleteMany = async (args: { where?: Row } = {}): Promise<{ count: number }> => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matchesWhere(r, args.where));
    return { count: before - this.rows.length };
  };
}

/**
 * Apply a Prisma `update` data object to a row, honouring the field-update
 * operators the services use (`{ increment }` / `{ decrement }` / `{ set }`).
 * A plain scalar is assigned directly.
 */
function applyUpdate(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      const op = value as { increment?: number; decrement?: number; set?: unknown };
      if (typeof op.increment === 'number') {
        row[key] = ((row[key] as number) ?? 0) + op.increment;
        continue;
      }
      if (typeof op.decrement === 'number') {
        row[key] = ((row[key] as number) ?? 0) - op.decrement;
        continue;
      }
      if ('set' in op) {
        row[key] = op.set;
        continue;
      }
    }
    row[key] = value;
  }
}

/** Composes the four catalog tables under the Prisma accessor names. */
export class FakeAcademyPrisma {
  readonly academyCourse = new FakeTable('course', { deletedAt: null });
  readonly academyCourseModule = new FakeTable('module', {});
  readonly academyLesson = new FakeTable('lesson', {});
  readonly academyCohort = new FakeTable('cohort', { deletedAt: null });
}
