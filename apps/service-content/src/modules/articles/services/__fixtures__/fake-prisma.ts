/**
 * In-memory Prisma fake for the article repository unit tests
 * (TS-284-followup-3). Implements the narrow surface `ArticleRepository`
 * consumes — `$transaction`, plus `article.{create,findUnique,findMany,update}`,
 * `articleVersion.{create,findFirst,findMany,update}`, and
 * `helpCategory.findUnique` (the category-assignment existence check). The real
 * FK / cascade behaviour + transactional guarantees are covered by the
 * Testcontainers integration test (a carried followup); this fake pins the
 * repository's wiring. Excluded from the build + coverage globs (it lives under
 * `__fixtures__/`). Mirrors the pages `FakeContentPrisma`.
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

/** Monotonic clock — strictly-increasing `createdAt` without `Date.now()`. */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 30, 0, 0, tick));
}

export class FakeArticlePrisma {
  articles: Row[] = [];
  versions: Row[] = [];
  categories: Row[] = [];
  articleAuthors: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** Seed a help category so the article category-assignment check passes. */
  seedCategory(id: string): void {
    this.categories.push({ id });
  }

  /** Seed an `article_authors` byline row (for the TS-286 search projection). */
  seedArticleAuthor(articleId: string, authorId: string, sortOrder: number): void {
    this.articleAuthors.push({ id: this.id('aa'), articleId, authorId, sortOrder });
  }

  readonly article = {
    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('art'),
        status: 'draft',
        categoryId: null,
        currentVersionId: null,
        newsletterSentAt: null,
        // Comments-config column defaults (TS-289) — mirrors the DDL defaults.
        commentsEnabled: false,
        commentsProvider: 'disqus',
        disqusIdentifier: null,
        ...args.data,
        createdAt: now,
        updatedAt: now,
      };
      this.articles.push(row);
      return row;
    },

    findUnique: async (args: {
      where: { id?: string; slug?: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => {
      if (args.where.id !== undefined)
        return this.articles.find((r) => r['id'] === args.where.id) ?? null;
      if (args.where.slug !== undefined)
        return this.articles.find((r) => r['slug'] === args.where.slug) ?? null;
      return null;
    },

    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.articles.filter((r) => matchesWhere(r, args.where));
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
      const row = this.articles.find((r) => r['id'] === args.where.id);
      if (row === undefined) throw new Error(`article ${args.where.id} not found`);
      Object.assign(row, args.data);
      row['updatedAt'] = nextDate();
      return row;
    },
  };

  readonly articleVersion = {
    create: async (args: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      const now = nextDate();
      const row: Row = {
        id: this.id('ver'),
        effectiveAt: null,
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

  readonly helpCategory = {
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => this.categories.find((r) => r['id'] === args.where.id) ?? null,
  };

  readonly articleAuthor = {
    findMany: async (args: FindManyArgs = {}): Promise<Row[]> => {
      let result = this.articleAuthors.filter((r) => matchesWhere(r, args.where));
      if (args.orderBy !== undefined)
        result = [...result].sort((a, b) => compare(a, b, args.orderBy));
      return result;
    },
  };

  /** Fake `$transaction` — invokes the callback with `this` as the tx client. */
  readonly $transaction = async <T>(cb: (tx: FakeArticlePrisma) => Promise<T>): Promise<T> =>
    cb(this);

  /**
   * Narrow fake of the parameterised raw `UPDATE … SET json_ld = NULL WHERE id = $1`
   * the SEO repository uses to clear the nullable `Json` column (the ORM null
   * sentinel is unavailable in this project). Only this one statement shape is
   * exercised; the id arrives as the single positional parameter.
   */
  readonly $executeRawUnsafe = async (_sql: string, id: string): Promise<number> => {
    const row = this.articles.find((r) => r['id'] === id);
    if (row === undefined) return 0;
    row['jsonLd'] = null;
    row['updatedAt'] = nextDate();
    return 1;
  };
}
