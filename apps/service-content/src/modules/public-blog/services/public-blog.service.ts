import { Injectable, Logger } from '@nestjs/common';
import {
  PUBLIC_BLOG_PAGE_SIZE,
  type AuthorSocialLinks,
  type PublicBlogArticle,
  type PublicBlogArticleListItem,
  type PublicBlogArticlesListResponse,
  type PublicBlogCategory,
  type PublicBlogComments,
} from '@taste-and-see/contracts';

import { toSeoRecord } from '../../articles/services/articles.service';
import {
  PublicBlogRepository,
  type PublicArticleListRow,
  type PublicBylineRow,
  type PublicCategoryRow,
} from '../repositories/public-blog.repository';

export interface ListPublicArticlesInput {
  readonly page: number;
  readonly categorySlug?: string | undefined;
}

export type PublicArticleOutcome =
  | { readonly ok: true; readonly article: PublicBlogArticle }
  | { readonly ok: false; readonly reason: 'not_found' };

/** An index row after the head-version merge — the sortable shape. */
interface MergedListRow {
  readonly row: PublicArticleListRow;
  readonly publishedAt: Date;
}

/**
 * The PUBLIC blog read projection (TS-282-followup-3; PRD §10.10; PDD §19.1).
 *
 * Serves ONLY published articles. The published predicate lives in the
 * repository `where` clauses, and this service additionally treats a missing
 * head version as `not_found` — so a draft, an archived post, and a slug that
 * never existed are all one uniform outcome (no draft-existence oracle,
 * mirroring the TS-287 feedback surface).
 *
 * Index ordering: newest `publishedAt` (the head version's `effectiveAt`)
 * first. The head version is a soft pointer, so the merge + sort happen here
 * over a capped scan (see `PUBLIC_BLOG_SCAN_CAP`) rather than in SQL.
 * `categories` on the list response is derived from the FULL published set
 * (the filter bar always shows every in-use category, whatever the filter).
 */
@Injectable()
export class PublicBlogService {
  private readonly logger = new Logger(PublicBlogService.name);

  constructor(private readonly repo: PublicBlogRepository) {}

  /** One page of the public index + paging facts + in-use categories. */
  async listArticles(input: ListPublicArticlesInput): Promise<PublicBlogArticlesListResponse> {
    const rows = await this.repo.listPublishedArticles();

    const headMeta = await this.repo.findHeadVersionMeta(
      rows.map((r) => r.currentVersionId).filter((id): id is string => id !== null),
    );
    const publishedAtByVersionId = new Map<string, Date | null>(
      headMeta.map((v) => [v.id, v.effectiveAt]),
    );

    const merged: MergedListRow[] = rows
      .filter((r) => r.currentVersionId !== null && publishedAtByVersionId.has(r.currentVersionId))
      .map((row) => ({
        row,
        // `publishVersion` stamps `effectiveAt` in the same transaction that
        // flips the status, so the fallback only guards a hand-edited row.
        publishedAt: publishedAtByVersionId.get(row.currentVersionId as string) ?? row.createdAt,
      }))
      .sort(
        (a, b) =>
          b.publishedAt.getTime() - a.publishedAt.getTime() || a.row.slug.localeCompare(b.row.slug),
      );

    const categories = distinctCategories(merged.map((m) => m.row.category));

    const filtered =
      input.categorySlug === undefined
        ? merged
        : merged.filter((m) => m.row.category?.slug === input.categorySlug);

    const totalArticles = filtered.length;
    const totalPages = Math.ceil(totalArticles / PUBLIC_BLOG_PAGE_SIZE);
    const pageRows = filtered.slice(
      (input.page - 1) * PUBLIC_BLOG_PAGE_SIZE,
      input.page * PUBLIC_BLOG_PAGE_SIZE,
    );

    const primaryAuthors = await this.repo.listPrimaryAuthors(pageRows.map((m) => m.row.id));
    const primaryByArticleId = new Map(primaryAuthors.map((p) => [p.articleId, p.author]));

    const articles: PublicBlogArticleListItem[] = pageRows.map((m) => {
      const primary = primaryByArticleId.get(m.row.id);
      return {
        slug: m.row.slug,
        title: m.row.title,
        publishedAt: m.publishedAt.toISOString(),
        metaDescription: m.row.metaDescription,
        category: m.row.category,
        primaryAuthor:
          primary === undefined
            ? null
            : { displayName: primary.displayName, photoAssetKey: primary.photoAssetKey },
      };
    });

    this.logger.log(
      {
        page: input.page,
        categorySlug: input.categorySlug ?? null,
        returned: articles.length,
        totalArticles,
      },
      'public blog index served',
    );

    return {
      articles,
      page: input.page,
      pageSize: PUBLIC_BLOG_PAGE_SIZE,
      totalArticles,
      totalPages,
      categories,
    };
  }

  /** A single published article by slug — the live body + SEO + byline. */
  async getArticleBySlug(slug: string): Promise<PublicArticleOutcome> {
    const article = await this.repo.findPublishedBySlug(slug);
    if (article === null || article.currentVersionId === null) {
      return { ok: false, reason: 'not_found' };
    }

    const head = await this.repo.findHeadVersionWithBody(article.id, article.currentVersionId);
    if (head === null) return { ok: false, reason: 'not_found' };

    const byline = await this.repo.listByline(article.id);

    this.logger.log({ slug, articleId: article.id }, 'public blog article served');

    return {
      ok: true,
      article: {
        slug: article.slug,
        title: article.title,
        body: head.body,
        publishedAt: (head.effectiveAt ?? article.createdAt).toISOString(),
        category: article.category,
        seo: toSeoRecord(article.seo),
        authors: byline.map(toPublicAuthor),
        comments: toPublicComments(article),
      },
    };
  }
}

/** Distinct in-use categories, alphabetical by name (stable filter bar). */
function distinctCategories(
  categories: ReadonlyArray<PublicCategoryRow | null>,
): PublicBlogCategory[] {
  const bySlug = new Map<string, PublicBlogCategory>();
  for (const category of categories) {
    if (category !== null && !bySlug.has(category.slug)) bySlug.set(category.slug, category);
  }
  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Project a byline row into the public author shape (never the `userId`). */
function toPublicAuthor(row: PublicBylineRow): PublicBlogArticle['authors'][number] {
  return {
    displayName: row.author.displayName,
    role: row.role,
    bio: row.author.bio,
    photoAssetKey: row.author.photoAssetKey,
    socialLinks: toSocialLinks(row.author.socialLinks),
  };
}

/**
 * Comments config as served publicly (TS-289 seam) — `null` unless the editor
 * enabled comments on the post, so a comments-dark post never advertises its
 * config. Provider narrowing mirrors the admin mapper (`disqus` unless the
 * stored text says otherwise).
 */
function toPublicComments(row: {
  readonly commentsEnabled: boolean;
  readonly commentsProvider: string;
  readonly disqusIdentifier: string | null;
}): PublicBlogComments | null {
  if (!row.commentsEnabled) return null;
  return {
    provider: row.commentsProvider === 'disqus' ? 'disqus' : 'none',
    disqusIdentifier: row.disqusIdentifier,
  };
}

function toSocialLinks(value: unknown): AuthorSocialLinks | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as AuthorSocialLinks;
}
