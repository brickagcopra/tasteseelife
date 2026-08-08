import { Injectable } from '@nestjs/common';
import type { ContentStatus } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirrors of the Prisma-generated `articles` / `article_versions` rows,
 * narrowed to the columns this module reads/writes. Same rationale as
 * `PageRepository` — Prisma's row types resolve inconsistently under our
 * tsconfig, so we project shapes by hand (mirrors the pages aggregate).
 */
export interface ArticleRow {
  readonly id: string;
  readonly slug: string;
  readonly status: ContentStatus;
  readonly title: string;
  readonly categoryId: string | null;
  readonly currentVersionId: string | null;
  /** When this post was sent to the newsletter (TS-288), or null. */
  readonly newsletterSentAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ArticleVersionRow {
  readonly id: string;
  readonly articleId: string;
  readonly versionNo: number;
  readonly title: string;
  readonly body: string;
  readonly effectiveAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The per-article SEO columns (TS-282). All nullable; `jsonLd` is `jsonb`. */
export interface ArticleSeoRow {
  readonly seoTitle: string | null;
  readonly metaDescription: string | null;
  readonly canonicalUrl: string | null;
  readonly ogTitle: string | null;
  readonly ogDescription: string | null;
  readonly ogImageKey: string | null;
  readonly twitterCard: string | null;
  readonly twitterTitle: string | null;
  readonly twitterDescription: string | null;
  readonly twitterImageKey: string | null;
  readonly jsonLd: unknown;
}

/** The per-article comments-config columns (TS-289). `commentsProvider` is
 *  persisted as text (narrowed to the wire enum at the mapper). */
export interface ArticleCommentsRow {
  readonly commentsEnabled: boolean;
  readonly commentsProvider: string;
  readonly disqusIdentifier: string | null;
}

/** Explicit column projections — never `SELECT *` (CLAUDE.md §4.1). */
const ARTICLE_SELECT = {
  id: true,
  slug: true,
  status: true,
  title: true,
  categoryId: true,
  currentVersionId: true,
  newsletterSentAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const VERSION_SELECT = {
  id: true,
  articleId: true,
  versionNo: true,
  title: true,
  body: true,
  effectiveAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** SEO column projection (TS-282). Read on the article-detail hydration + SEO PATCH. */
const ARTICLE_SEO_SELECT = {
  seoTitle: true,
  metaDescription: true,
  canonicalUrl: true,
  ogTitle: true,
  ogDescription: true,
  ogImageKey: true,
  twitterCard: true,
  twitterTitle: true,
  twitterDescription: true,
  twitterImageKey: true,
  jsonLd: true,
} as const;

/** Comments-config column projection (TS-289). Read on the article-detail
 *  hydration + comments PATCH. */
const ARTICLE_COMMENTS_SELECT = {
  commentsEnabled: true,
  commentsProvider: true,
  disqusIdentifier: true,
} as const;

/**
 * SEO patch. Every field is optional; a supplied value (including `null` to
 * clear) is written, an omitted field is left unchanged. Scalar fields patch
 * through the ORM; `jsonLd` writes a value through the ORM but clears to DB NULL
 * through a raw `UPDATE` (see `updateSeo`).
 */
export interface ArticleSeoUpdateData {
  readonly seoTitle?: string | null | undefined;
  readonly metaDescription?: string | null | undefined;
  readonly canonicalUrl?: string | null | undefined;
  readonly ogTitle?: string | null | undefined;
  readonly ogDescription?: string | null | undefined;
  readonly ogImageKey?: string | null | undefined;
  readonly twitterCard?: string | null | undefined;
  readonly twitterTitle?: string | null | undefined;
  readonly twitterDescription?: string | null | undefined;
  readonly twitterImageKey?: string | null | undefined;
  readonly jsonLd?: unknown | null | undefined;
}

/** Scalar (non-`jsonLd`) SEO columns — iterated for the partial-update patch. */
const SEO_SCALAR_KEYS = [
  'seoTitle',
  'metaDescription',
  'canonicalUrl',
  'ogTitle',
  'ogDescription',
  'ogImageKey',
  'twitterCard',
  'twitterTitle',
  'twitterDescription',
  'twitterImageKey',
] as const;

/**
 * Comments-config patch (TS-289). Every field is optional; a supplied value
 * (including `disqusIdentifier: null` to clear) is written, an omitted field is
 * left unchanged. All three columns are scalar — no raw-NULL special case (the
 * `jsonLd` quirk is JSON-only).
 */
export interface ArticleCommentsUpdateData {
  readonly commentsEnabled?: boolean | undefined;
  readonly commentsProvider?: string | undefined;
  readonly disqusIdentifier?: string | null | undefined;
}

/** Comments-config columns — iterated for the partial-update patch. */
const COMMENTS_KEYS = ['commentsEnabled', 'commentsProvider', 'disqusIdentifier'] as const;

export interface ArticleWriteData {
  readonly slug: string;
  readonly title: string;
  readonly categoryId: string | null;
}

export interface ArticleUpdateData {
  readonly title?: string | undefined;
  /** Present = set (including `null` to clear); absent = leave unchanged. */
  readonly categoryId?: string | null | undefined;
}

export interface ArticleVersionWriteData {
  readonly title: string;
  readonly body: string;
  readonly createdBy: string;
}

export interface ArticleDetailRows {
  readonly article: ArticleRow;
  readonly versions: readonly ArticleVersionRow[];
  readonly seo: ArticleSeoRow;
  readonly comments: ArticleCommentsRow;
}

export interface PublishResultRows {
  readonly article: ArticleRow;
  readonly version: ArticleVersionRow;
}

/**
 * Persistence for the blog/help-article aggregate (TS-284-followup-3; PDD §8.2,
 * §19). Mirrors `PageRepository` — the two `content`-schema tables are
 * `unscopedModel`s, so the tenant-scope gate short-circuits. Lifecycle decisions
 * live in `ArticlesService`; `onPersist` (when supplied) runs INSIDE the
 * mutation transaction (the audit-outbox append) so the audit row commits
 * atomically with the state change (CLAUDE.md §3.6, §5.3).
 */
@Injectable()
export class ArticleRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Create an article shell (draft, no version). */
  async createArticle(
    data: ArticleWriteData,
    onPersist?: (tx: PrismaTransactionClient, created: ArticleRow) => Promise<void>,
  ): Promise<ArticleRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = (await tx.article.create({
        data: { slug: data.slug, title: data.title, categoryId: data.categoryId },
        select: ARTICLE_SELECT,
      })) as ArticleRow;
      if (onPersist !== undefined) await onPersist(tx, created);
      return created;
    });
  }

  /** Update editorial metadata (title / category). */
  async updateArticle(
    id: string,
    data: ArticleUpdateData,
    onPersist?: (tx: PrismaTransactionClient, updated: ArticleRow) => Promise<void>,
  ): Promise<ArticleRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const patch: Record<string, unknown> = {};
      if (data.title !== undefined) patch['title'] = data.title;
      if (data.categoryId !== undefined) patch['categoryId'] = data.categoryId;

      const updated = (await tx.article.update({
        where: { id },
        data: patch,
        select: ARTICLE_SELECT,
      })) as ArticleRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }

  /** Shallow article row by slug, or null. */
  async findArticleBySlug(slug: string): Promise<ArticleRow | null> {
    return (await this.prisma.article.findUnique({
      where: { slug },
      select: ARTICLE_SELECT,
    })) as ArticleRow | null;
  }

  /** Shallow article row by id, or null. */
  async findArticle(id: string): Promise<ArticleRow | null> {
    return (await this.prisma.article.findUnique({
      where: { id },
      select: ARTICLE_SELECT,
    })) as ArticleRow | null;
  }

  /** True when a help category with this id exists (category-assignment guard). */
  async helpCategoryExists(categoryId: string): Promise<boolean> {
    const found = (await this.prisma.helpCategory.findUnique({
      where: { id: categoryId },
      select: { id: true },
    })) as { id: string } | null;
    return found !== null;
  }

  /** Matching articles ordered by `createdAt` descending (newest first). */
  async listArticles(filter: {
    readonly status?: ContentStatus | undefined;
    readonly categoryId?: string | undefined;
    readonly limit: number;
  }): Promise<readonly ArticleRow[]> {
    const where: Record<string, unknown> = {};
    if (filter.status !== undefined) where['status'] = filter.status;
    if (filter.categoryId !== undefined) where['categoryId'] = filter.categoryId;

    return (await this.prisma.article.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      select: ARTICLE_SELECT,
    })) as ArticleRow[];
  }

  /** Article + its versions (newest-first) + its SEO block + its comments
   *  config, or null when no article resolves. */
  async findDetail(id: string): Promise<ArticleDetailRows | null> {
    const article = await this.findArticle(id);
    if (article === null) return null;

    const versions = (await this.prisma.articleVersion.findMany({
      where: { articleId: id },
      orderBy: [{ versionNo: 'desc' }],
      select: VERSION_SELECT,
    })) as ArticleVersionRow[];

    const seo = (await this.prisma.article.findUnique({
      where: { id },
      select: ARTICLE_SEO_SELECT,
    })) as ArticleSeoRow;

    const comments = (await this.prisma.article.findUnique({
      where: { id },
      select: ARTICLE_COMMENTS_SELECT,
    })) as ArticleCommentsRow;

    return { article, versions, seo, comments };
  }

  /** The SEO block for an article, or null when the article does not resolve. */
  async findSeo(id: string): Promise<ArticleSeoRow | null> {
    return (await this.prisma.article.findUnique({
      where: { id },
      select: ARTICLE_SEO_SELECT,
    })) as ArticleSeoRow | null;
  }

  /** The comments config for an article, or null when the article does not resolve. */
  async findComments(id: string): Promise<ArticleCommentsRow | null> {
    return (await this.prisma.article.findUnique({
      where: { id },
      select: ARTICLE_COMMENTS_SELECT,
    })) as ArticleCommentsRow | null;
  }

  /**
   * Partial-update the per-article comments-config columns (TS-289). Present
   * fields are written (`disqusIdentifier: null` clears); omitted fields are
   * untouched. `onPersist` (the audit-outbox append) runs INSIDE the
   * transaction so the audit row commits atomically (mirrors `updateSeo`,
   * minus the JSON-clear special case — all three columns are scalar).
   */
  async updateComments(
    id: string,
    data: ArticleCommentsUpdateData,
    onPersist?: (tx: PrismaTransactionClient, updated: ArticleCommentsRow) => Promise<void>,
  ): Promise<ArticleCommentsRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const patch: Record<string, unknown> = {};
      for (const key of COMMENTS_KEYS) {
        if (data[key] !== undefined) patch[key] = data[key];
      }

      if (Object.keys(patch).length > 0) {
        await tx.article.update({ where: { id }, data: patch, select: { id: true } });
      }

      const updated = (await tx.article.findUnique({
        where: { id },
        select: ARTICLE_COMMENTS_SELECT,
      })) as ArticleCommentsRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }

  /**
   * The ordered byline author ids for an article (`article_authors` by
   * ascending `sort_order`), for the `content.article.published` search
   * projection (TS-286). Empty when the article has no byline. Read outside the
   * publish transaction (eventual-consistency is fine for a search projection —
   * the doc is re-emitted on every publish).
   */
  async listArticleAuthorIds(articleId: string): Promise<readonly string[]> {
    const rows = (await this.prisma.articleAuthor.findMany({
      where: { articleId },
      orderBy: [{ sortOrder: 'asc' }, { authorId: 'asc' }],
      select: { authorId: true },
    })) as ReadonlyArray<{ readonly authorId: string }>;
    return rows.map((r) => r.authorId);
  }

  /**
   * Partial-update the per-article SEO columns. Present fields are written
   * (`null` clears); omitted fields are untouched. `onPersist` (the audit-outbox
   * append) runs INSIDE the transaction so the audit row commits atomically.
   *
   * `jsonLd` is handled apart from the scalar patch: setting a nullable `Json`
   * column to a value writes it via the ORM, but clearing it to DB NULL goes
   * through a parameterised raw `UPDATE` — the `Prisma.DbNull` null-sentinel is
   * not exposed through this project's `@prisma/client` resolution (the same
   * hand-projection quirk the row types work around above).
   */
  async updateSeo(
    id: string,
    data: ArticleSeoUpdateData,
    onPersist?: (tx: PrismaTransactionClient, updated: ArticleSeoRow) => Promise<void>,
  ): Promise<ArticleSeoRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const patch: Record<string, unknown> = {};
      for (const key of SEO_SCALAR_KEYS) {
        if (data[key] !== undefined) patch[key] = data[key];
      }
      // A JSON *value* rides the ORM patch; a JSON *clear* is a raw NULL below.
      if (data.jsonLd !== undefined && data.jsonLd !== null) patch['jsonLd'] = data.jsonLd;

      if (Object.keys(patch).length > 0) {
        await tx.article.update({ where: { id }, data: patch, select: { id: true } });
      }
      if (data.jsonLd === null) {
        await tx.$executeRawUnsafe(
          'UPDATE "content"."articles" SET "json_ld" = NULL WHERE "id" = $1',
          id,
        );
      }

      const updated = (await tx.article.findUnique({
        where: { id },
        select: ARTICLE_SEO_SELECT,
      })) as ArticleSeoRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }

  /**
   * Append a new version, assigning the next monotonic `versionNo` per article
   * inside the transaction (read the current max, then insert max + 1). The
   * `article_versions_article_id_version_no_key` unique index is the backstop
   * against a concurrent double-append.
   */
  async appendVersion(
    articleId: string,
    data: ArticleVersionWriteData,
    onPersist?: (tx: PrismaTransactionClient, created: ArticleVersionRow) => Promise<void>,
  ): Promise<ArticleVersionRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const last = (await tx.articleVersion.findFirst({
        where: { articleId },
        orderBy: [{ versionNo: 'desc' }],
        select: { versionNo: true },
      })) as { versionNo: number } | null;
      const versionNo = (last?.versionNo ?? 0) + 1;

      const created = (await tx.articleVersion.create({
        data: {
          articleId,
          versionNo,
          title: data.title,
          body: data.body,
          createdBy: data.createdBy,
        },
        select: VERSION_SELECT,
      })) as ArticleVersionRow;
      if (onPersist !== undefined) await onPersist(tx, created);
      return created;
    });
  }

  /** A version scoped to its article, or null when it does not resolve. */
  async findVersion(articleId: string, versionId: string): Promise<ArticleVersionRow | null> {
    return (await this.prisma.articleVersion.findFirst({
      where: { id: versionId, articleId },
      select: VERSION_SELECT,
    })) as ArticleVersionRow | null;
  }

  /**
   * Publish a version: stamp its `effectiveAt`, repoint the article's
   * `currentVersionId`, and move the article to `published` — all in one
   * transaction. `onPersist` runs inside it (the audit-outbox append).
   */
  async publishVersion(
    articleId: string,
    versionId: string,
    effectiveAt: Date,
    onPersist?: (tx: PrismaTransactionClient, result: PublishResultRows) => Promise<void>,
  ): Promise<PublishResultRows> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const version = (await tx.articleVersion.update({
        where: { id: versionId },
        data: { effectiveAt },
        select: VERSION_SELECT,
      })) as ArticleVersionRow;

      const article = (await tx.article.update({
        where: { id: articleId },
        data: { currentVersionId: versionId, status: 'published' },
        select: ARTICLE_SELECT,
      })) as ArticleRow;

      const result = { article, version };
      if (onPersist !== undefined) await onPersist(tx, result);
      return result;
    });
  }

  /**
   * Mark a post sent to the newsletter (TS-288): stamp `newsletterSentAt` +
   * `newsletterSentBy` in one transaction. `onPersist` runs inside it — the
   * audit-outbox append AND the `content.newsletter.send_requested` domain-event
   * append — so the send guard and its delivery signal commit atomically
   * (CLAUDE.md §5.3). The published/not-yet-sent preconditions are enforced by
   * the service before this is called.
   */
  async markNewsletterSent(
    articleId: string,
    sentAt: Date,
    sentBy: string,
    onPersist?: (tx: PrismaTransactionClient, updated: ArticleRow) => Promise<void>,
  ): Promise<ArticleRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const updated = (await tx.article.update({
        where: { id: articleId },
        data: { newsletterSentAt: sentAt, newsletterSentBy: sentBy },
        select: ARTICLE_SELECT,
      })) as ArticleRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }
}
