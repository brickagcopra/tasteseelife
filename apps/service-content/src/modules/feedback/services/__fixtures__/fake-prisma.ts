/**
 * In-memory Prisma fake for the article-feedback repository unit tests (TS-287).
 * Implements only the narrow surface `ArticleFeedbackRepository` consumes:
 * `article.{findUnique,findMany}`, `articleFeedback.{upsert,findUnique,count}`,
 * and `articleAuthor.findMany` (incl. the `{ in: [...] }` filter). The real FK /
 * cascade behaviour is covered by the Testcontainers integration test (a carried
 * followup). Excluded from build + coverage globs (`__fixtures__/`).
 */

type Row = Record<string, unknown>;

interface OrderClause {
  [field: string]: 'asc' | 'desc';
}

/** Monotonic clock — strictly-increasing `createdAt` without `Date.now()`. */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 5, 30, 0, 0, tick));
}

export class FakeFeedbackPrisma {
  articles: Row[] = [];
  feedback: Row[] = [];
  authorLinks: Row[] = [];
  private counter = 0;

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  /** Seed an article (defaults: published, no category). */
  seedArticle(article: {
    id: string;
    status?: 'draft' | 'published' | 'archived';
    categoryId?: string | null;
    slug?: string;
    title?: string;
    createdAt?: Date;
  }): void {
    this.articles.push({
      id: article.id,
      status: article.status ?? 'published',
      categoryId: article.categoryId ?? null,
      slug: article.slug ?? `${article.id}-slug`,
      title: article.title ?? `${article.id} title`,
      createdAt: article.createdAt ?? nextDate(),
    });
  }

  /** Seed a byline credit (articleId → authorId). */
  seedAuthorLink(articleId: string, authorId: string): void {
    this.authorLinks.push({ articleId, authorId });
  }

  /** Seed an existing vote directly. */
  seedVote(articleId: string, userId: string, rating: 'helpful' | 'not_helpful'): void {
    this.feedback.push({ id: this.id('fb'), articleId, userId, rating });
  }

  readonly article = {
    findUnique: async (args: {
      where: { id: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => this.articles.find((r) => r['id'] === args.where.id) ?? null,

    findMany: async (args: {
      where?: { status?: string };
      orderBy?: OrderClause[] | OrderClause;
      take?: number;
      select?: Record<string, boolean>;
    }): Promise<Row[]> => {
      let result = this.articles.filter(
        (r) => args.where?.status === undefined || r['status'] === args.where.status,
      );
      const clauses =
        args.orderBy === undefined
          ? []
          : Array.isArray(args.orderBy)
            ? args.orderBy
            : [args.orderBy];
      result = [...result].sort((a, b) => {
        for (const clause of clauses) {
          const [field, dir] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
          const av = a[field];
          const bv = b[field];
          let cmp = 0;
          if (av instanceof Date && bv instanceof Date) cmp = av.getTime() - bv.getTime();
          else cmp = String(av).localeCompare(String(bv));
          if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
      if (typeof args.take === 'number') result = result.slice(0, args.take);
      return result;
    },
  };

  readonly articleFeedback = {
    upsert: async (args: {
      where: { articleId_userId: { articleId: string; userId: string } };
      create: Row;
      update: Row;
      select?: Record<string, boolean>;
    }): Promise<Row> => {
      const { articleId, userId } = args.where.articleId_userId;
      const existing = this.feedback.find(
        (r) => r['articleId'] === articleId && r['userId'] === userId,
      );
      if (existing !== undefined) {
        Object.assign(existing, args.update);
        return { id: existing['id'] };
      }
      const row: Row = { id: this.id('fb'), ...args.create };
      this.feedback.push(row);
      return { id: row['id'] };
    },

    findUnique: async (args: {
      where: { articleId_userId: { articleId: string; userId: string } };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => {
      const { articleId, userId } = args.where.articleId_userId;
      return (
        this.feedback.find((r) => r['articleId'] === articleId && r['userId'] === userId) ?? null
      );
    },

    count: async (args: { where: { articleId: string; rating?: string } }): Promise<number> =>
      this.feedback.filter(
        (r) =>
          r['articleId'] === args.where.articleId &&
          (args.where.rating === undefined || r['rating'] === args.where.rating),
      ).length,
  };

  readonly articleAuthor = {
    findMany: async (args: {
      where: { articleId?: string | { in: string[] } };
      select?: Record<string, boolean>;
    }): Promise<Row[]> => {
      const where = args.where.articleId;
      return this.authorLinks.filter((r) => {
        if (where === undefined) return true;
        if (typeof where === 'string') return r['articleId'] === where;
        return where.in.includes(r['articleId'] as string);
      });
    },
  };
}
