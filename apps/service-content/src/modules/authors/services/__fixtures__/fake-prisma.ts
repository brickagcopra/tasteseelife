/**
 * In-memory Prisma fake for the author repository/service unit tests (TS-283).
 * Implements the narrow surface `AuthorRepository` consumes — `$transaction`,
 * `contentAuthor.{create,findUnique,findMany,update}`,
 * `articleAuthor.{deleteMany,create,findMany}`, `article.findUnique`, and the
 * parameterised raw `UPDATE … social_links = NULL`. The real FK / cascade /
 * transactional guarantees are covered by the Testcontainers integration test (a
 * carried followup); this fake pins the repository wiring. Excluded from build +
 * coverage globs (`__fixtures__/`). Mirrors the articles `FakeArticlePrisma`.
 */

type Row = Record<string, unknown>;

interface FindManyArgs {
  where?: Row;
  orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>> | Record<string, 'asc' | 'desc'>;
  take?: number;
  select?: Record<string, unknown>;
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

/** Monotonic clock — strictly-increasing timestamps without `Date.now()`. */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 30, 0, 0, tick));
}

export class FakeAuthorPrisma {
  authors: Row[] = [];
  articles: Row[] = [];
  links: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** Seed an article so the byline-set existence check passes. */
  seedArticle(id: string): void {
    this.articles.push({ id });
  }

  readonly contentAuthor = {
    create: async (args: { data: Row; select?: Record<string, unknown> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('author'),
        bio: null,
        photoAssetKey: null,
        socialLinks: null,
        ...args.data,
        createdAt: now,
        updatedAt: now,
      };
      this.authors.push(row);
      return row;
    },

    findUnique: async (args: {
      where: { id?: string; userId?: string };
      select?: Record<string, unknown>;
    }): Promise<Row | null> => {
      if (args.where.id !== undefined)
        return this.authors.find((r) => r['id'] === args.where.id) ?? null;
      if (args.where.userId !== undefined) {
        return this.authors.find((r) => r['userId'] === args.where.userId) ?? null;
      }
      return null;
    },

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.authors.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      if (typeof args.take === 'number') result = result.slice(0, args.take);
      return result;
    },

    update: async (args: {
      where: { id: string };
      data: Row;
      select?: Record<string, unknown>;
    }): Promise<Row> => {
      const row = this.authors.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`author ${args.where.id} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  readonly article = {
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, unknown>;
    }): Promise<Row | null> => this.articles.find((r) => r['id'] === args.where.id) ?? null,
  };

  readonly articleAuthor = {
    deleteMany: async (args: { where: { articleId: string } }): Promise<{ count: number }> => {
      const before = this.links.length;
      this.links = this.links.filter((r) => r['articleId'] !== args.where.articleId);
      return { count: before - this.links.length };
    },

    create: async (args: { data: Row; select?: Record<string, unknown> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = { id: this.id('link'), ...args.data, createdAt: now, updatedAt: now };
      this.links.push(row);
      return row;
    },

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.links.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      // Hydrate the `author` relation the byline reader selects.
      return result.map((link) => ({
        authorRole: link['authorRole'],
        sortOrder: link['sortOrder'],
        author: this.authors.find((a) => a['id'] === link['authorId']) ?? null,
      }));
    },
  };

  /** Fake `$transaction` — invokes the callback with `this` as the tx client. */
  readonly $transaction = async <T>(cb: (tx: FakeAuthorPrisma) => Promise<T>): Promise<T> =>
    cb(this);

  /** Narrow fake of the raw `UPDATE … social_links = NULL WHERE id = $1` clear. */
  readonly $executeRawUnsafe = async (_sql: string, id: string): Promise<number> => {
    const row = this.authors.find((r) => r['id'] === id);
    if (row === undefined) return 0;
    row['socialLinks'] = null;
    row['updatedAt'] = nextDate();
    return 1;
  };
}
