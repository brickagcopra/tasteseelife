import { Injectable } from '@nestjs/common';
import type { ContentAuthorRole } from '@taste-and-see/contracts';

import type { ArticleSeoRow } from '../../articles/repositories/article.repository';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Hand-projected row shapes for the PUBLIC blog read path (TS-282-followup-3).
 * Same rationale as the sibling repositories — Prisma's row types resolve
 * inconsistently under our tsconfig, so shapes are projected by hand. Every
 * select below is an explicit column list (CLAUDE.md §4.1); none of them ever
 * projects `createdBy`, newsletter fields, or draft version bodies.
 */

/** The embedded category chip (slug + name), or null (uncategorised post). */
export interface PublicCategoryRow {
  readonly slug: string;
  readonly name: string;
}

/** An index-card article row (no body). */
export interface PublicArticleListRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly metaDescription: string | null;
  readonly currentVersionId: string | null;
  readonly createdAt: Date;
  readonly category: PublicCategoryRow | null;
}

/** The single-article detail row — card facts + SEO + comments config. */
export interface PublicArticleDetailRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly currentVersionId: string | null;
  readonly createdAt: Date;
  readonly category: PublicCategoryRow | null;
  readonly seo: ArticleSeoRow;
  readonly commentsEnabled: boolean;
  readonly commentsProvider: string;
  readonly disqusIdentifier: string | null;
}

/** Head-version facts for the index ordering (`effectiveAt` = publishedAt). */
export interface PublicHeadVersionRow {
  readonly id: string;
  readonly effectiveAt: Date | null;
}

/** Head-version facts + the live Markdown body (detail page only). */
export interface PublicHeadVersionBodyRow extends PublicHeadVersionRow {
  readonly title: string;
  readonly body: string;
}

/** A byline credit joined to its author profile (public projection — no `userId`). */
export interface PublicBylineRow {
  readonly role: ContentAuthorRole;
  readonly sortOrder: number;
  readonly author: {
    readonly displayName: string;
    readonly bio: string | null;
    readonly photoAssetKey: string | null;
    readonly socialLinks: unknown;
  };
}

/** The primary (position-0) byline author per article, batch-read for the index. */
export interface PublicPrimaryAuthorRow {
  readonly articleId: string;
  readonly author: {
    readonly displayName: string;
    readonly photoAssetKey: string | null;
  };
}

const PUBLIC_CATEGORY_SELECT = { slug: true, name: true } as const;

const PUBLIC_SEO_SELECT = {
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

/**
 * Hard cap on the published-article scan backing the index (sort by head
 * `publishedAt` happens in the service — the head version is a SOFT pointer,
 * so the order key is not joinable in a single Prisma query). A marketing
 * blog lives in the hundreds of posts; if the catalog ever approaches this
 * cap, denormalise a `published_at` column onto `articles` (+ index) and
 * push the ordering into SQL. The cap keeps a runaway catalog from turning
 * the public index into an unbounded scan.
 */
export const PUBLIC_BLOG_SCAN_CAP = 1_000;

/**
 * Persistence for the PUBLIC blog read surface (TS-282-followup-3). Published
 * rows only — every query carries `status: 'published'` in its `where`, so a
 * draft/archived article is indistinguishable from a missing one at this
 * layer (no draft-existence oracle). All models are `unscopedModel`s; the
 * anonymous entrypoint wraps calls in `runWithoutTenantContext` at the
 * controller (see `app.module.ts`).
 */
@Injectable()
export class PublicBlogRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every published article's card facts (capped scan — see
   * {@link PUBLIC_BLOG_SCAN_CAP}). The service merges head-version
   * `effectiveAt`, sorts, filters, and paginates.
   */
  async listPublishedArticles(): Promise<readonly PublicArticleListRow[]> {
    return (await this.prisma.article.findMany({
      where: { status: 'published', currentVersionId: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PUBLIC_BLOG_SCAN_CAP,
      select: {
        id: true,
        slug: true,
        title: true,
        metaDescription: true,
        currentVersionId: true,
        createdAt: true,
        category: { select: PUBLIC_CATEGORY_SELECT },
      },
    })) as PublicArticleListRow[];
  }

  /** Head-version publish stamps for a batch of version ids. */
  async findHeadVersionMeta(
    versionIds: readonly string[],
  ): Promise<readonly PublicHeadVersionRow[]> {
    if (versionIds.length === 0) return [];
    return (await this.prisma.articleVersion.findMany({
      where: { id: { in: [...versionIds] } },
      select: { id: true, effectiveAt: true },
    })) as PublicHeadVersionRow[];
  }

  /** The position-0 byline author for each article in the batch. */
  async listPrimaryAuthors(
    articleIds: readonly string[],
  ): Promise<readonly PublicPrimaryAuthorRow[]> {
    if (articleIds.length === 0) return [];
    return (await this.prisma.articleAuthor.findMany({
      where: { articleId: { in: [...articleIds] }, sortOrder: 0 },
      select: {
        articleId: true,
        author: { select: { displayName: true, photoAssetKey: true } },
      },
    })) as PublicPrimaryAuthorRow[];
  }

  /**
   * A PUBLISHED article's detail row by slug, or null. The `status` predicate
   * lives in the `where` — a draft/archived slug probe resolves exactly like a
   * missing one.
   */
  async findPublishedBySlug(slug: string): Promise<PublicArticleDetailRow | null> {
    const row = (await this.prisma.article.findFirst({
      where: { slug, status: 'published' },
      select: {
        id: true,
        slug: true,
        title: true,
        currentVersionId: true,
        createdAt: true,
        category: { select: PUBLIC_CATEGORY_SELECT },
        commentsEnabled: true,
        commentsProvider: true,
        disqusIdentifier: true,
        ...PUBLIC_SEO_SELECT,
      },
    })) as (Omit<PublicArticleDetailRow, 'seo'> & ArticleSeoRow) | null;
    if (row === null) return null;

    const {
      id,
      slug: rowSlug,
      title,
      currentVersionId,
      createdAt,
      category,
      commentsEnabled,
      commentsProvider,
      disqusIdentifier,
      ...seo
    } = row;
    return {
      id,
      slug: rowSlug,
      title,
      currentVersionId,
      createdAt,
      category,
      commentsEnabled,
      commentsProvider,
      disqusIdentifier,
      seo,
    };
  }

  /** The live (head) version row with its Markdown body, scoped to its article. */
  async findHeadVersionWithBody(
    articleId: string,
    versionId: string,
  ): Promise<PublicHeadVersionBodyRow | null> {
    return (await this.prisma.articleVersion.findFirst({
      where: { id: versionId, articleId },
      select: { id: true, effectiveAt: true, title: true, body: true },
    })) as PublicHeadVersionBodyRow | null;
  }

  /** The full ordered byline for one article (public projection — no `userId`). */
  async listByline(articleId: string): Promise<readonly PublicBylineRow[]> {
    // The column is `authorRole`, not `role` — this selected a field that
    // does not exist on the model, which Prisma rejects at runtime
    // ("Unknown field `role` for select statement"). It only ever compiled
    // because the pre-TS-500 client stub had no model types and the `as`
    // cast papered over the mismatch, so every public byline read threw.
    // Selected under its real name and mapped to the public `role` key
    // (TS-501).
    const rows = await this.prisma.articleAuthor.findMany({
      where: { articleId },
      orderBy: [{ sortOrder: 'asc' }, { authorId: 'asc' }],
      select: {
        authorRole: true,
        sortOrder: true,
        author: {
          select: { displayName: true, bio: true, photoAssetKey: true, socialLinks: true },
        },
      },
    });
    return rows.map((row) => ({
      role: row.authorRole,
      sortOrder: row.sortOrder,
      author: row.author,
    }));
  }
}
