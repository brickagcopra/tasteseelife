import { z } from 'zod';

import {
  ArticleCommentsProviderSchema,
  ArticleSeoSchema,
  CONTENT_ARTICLE_SLUG_MAX_LENGTH,
  CONTENT_ARTICLE_SLUG_REGEX,
  CONTENT_ARTICLE_TITLE_MAX_LENGTH,
  CONTENT_ARTICLE_BODY_MAX_LENGTH,
  CONTENT_DISQUS_IDENTIFIER_MAX_LENGTH,
  CONTENT_SEO_META_DESCRIPTION_MAX_LENGTH,
} from './content-article.schema';
import {
  AuthorSocialLinksSchema,
  CONTENT_AUTHOR_BIO_MAX_LENGTH,
  CONTENT_AUTHOR_DISPLAY_NAME_MAX_LENGTH,
  CONTENT_AUTHOR_PHOTO_KEY_MAX_LENGTH,
  ContentAuthorRoleSchema,
} from './content-author.schema';
import {
  CONTENT_HELP_CATEGORY_NAME_MAX_LENGTH,
  CONTENT_HELP_CATEGORY_SLUG_MAX_LENGTH,
  CONTENT_HELP_CATEGORY_SLUG_REGEX,
} from './content-help-category.schema';

/**
 * PUBLIC blog read contracts (TS-282-followup-3; PRD §10.10; PDD §19.1) — the
 * anonymous, unauthenticated projection of PUBLISHED articles served to the
 * web-marketing `/blog` surface through the gateway.
 *
 * This is a deliberate STRICT SUBSET of the admin article shapes. It must
 * never carry:
 *   - anything with `status != 'published'` (drafts/archived are 404s);
 *   - version history or draft bodies (only the head version's body);
 *   - internal provenance (`createdBy`, `currentVersionId`, ids, newsletter
 *     fields) or author identity references (`userId`).
 *
 * The gateway parse-checks downstream bodies against these schemas, so a
 * drifted (over-sharing) service response is a 502 at the edge, never a leak.
 */

// ─── Field schemas (reusing the authoring caps/regexes) ─────────────────

const PublicSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(CONTENT_ARTICLE_SLUG_MAX_LENGTH)
  .regex(
    CONTENT_ARTICLE_SLUG_REGEX,
    'slug must be lowercase kebab-case (a-z, 0-9, hyphen-separated)',
  );
const PublicTitleSchema = z.string().trim().min(1).max(CONTENT_ARTICLE_TITLE_MAX_LENGTH);
const PublicBodySchema = z.string().min(1).max(CONTENT_ARTICLE_BODY_MAX_LENGTH);
const PublicTimestampSchema = z.string().datetime({ offset: true });

/** Fixed public page size — a server-owned constant, not a client knob. */
export const PUBLIC_BLOG_PAGE_SIZE = 12;
/** Upper bound on the requestable page number (a hostile `?page=` cap). */
export const PUBLIC_BLOG_PAGE_MAX = 10_000;

// ─── Category ───────────────────────────────────────────────────────────

/** A category chip on the public blog — slug (the filter key) + display name. */
export const PublicBlogCategorySchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(1)
      .max(CONTENT_HELP_CATEGORY_SLUG_MAX_LENGTH)
      .regex(CONTENT_HELP_CATEGORY_SLUG_REGEX),
    name: z.string().trim().min(1).max(CONTENT_HELP_CATEGORY_NAME_MAX_LENGTH),
  })
  .strict();
export type PublicBlogCategory = z.infer<typeof PublicBlogCategorySchema>;

// ─── Byline author ──────────────────────────────────────────────────────

/**
 * A credited author on the public byline (TS-281-followup-5). Carries the
 * editorial profile only — never the author's `userId` (a soft
 * service-identity reference) or row id.
 */
export const PublicBlogAuthorSchema = z
  .object({
    displayName: z.string().trim().min(1).max(CONTENT_AUTHOR_DISPLAY_NAME_MAX_LENGTH),
    role: ContentAuthorRoleSchema,
    bio: z.string().trim().min(1).max(CONTENT_AUTHOR_BIO_MAX_LENGTH).nullable(),
    photoAssetKey: z.string().trim().min(1).max(CONTENT_AUTHOR_PHOTO_KEY_MAX_LENGTH).nullable(),
    socialLinks: AuthorSocialLinksSchema.nullable(),
  })
  .strict();
export type PublicBlogAuthor = z.infer<typeof PublicBlogAuthorSchema>;

// ─── Comments config ────────────────────────────────────────────────────

/**
 * Per-post comments config as served publicly (TS-289 seam). Present ONLY when
 * the editor enabled comments on the post — a disabled post carries `null`, so
 * the public payload never advertises the config of a comments-dark post. The
 * embed itself is TS-289-followup-1; `disqusIdentifier` null = the embed falls
 * back to the article slug.
 */
export const PublicBlogCommentsSchema = z
  .object({
    provider: ArticleCommentsProviderSchema,
    disqusIdentifier: z.string().trim().min(1).max(CONTENT_DISQUS_IDENTIFIER_MAX_LENGTH).nullable(),
  })
  .strict();
export type PublicBlogComments = z.infer<typeof PublicBlogCommentsSchema>;

// ─── List item ──────────────────────────────────────────────────────────

/**
 * A published article as it appears on the `/blog` index — card facts only
 * (no body). `metaDescription` doubles as the card excerpt when set.
 * `primaryAuthor` is the first credited author (byline position 0), or null
 * for an uncredited post.
 */
export const PublicBlogArticleListItemSchema = z
  .object({
    slug: PublicSlugSchema,
    title: PublicTitleSchema,
    publishedAt: PublicTimestampSchema,
    metaDescription: z
      .string()
      .trim()
      .min(1)
      .max(CONTENT_SEO_META_DESCRIPTION_MAX_LENGTH)
      .nullable(),
    category: PublicBlogCategorySchema.nullable(),
    primaryAuthor: z
      .object({
        displayName: z.string().trim().min(1).max(CONTENT_AUTHOR_DISPLAY_NAME_MAX_LENGTH),
        photoAssetKey: z.string().trim().min(1).max(CONTENT_AUTHOR_PHOTO_KEY_MAX_LENGTH).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type PublicBlogArticleListItem = z.infer<typeof PublicBlogArticleListItemSchema>;

// ─── Detail ─────────────────────────────────────────────────────────────

/**
 * A single published article as served on `/blog/[slug]` — the head version's
 * Markdown body (rendered ONLY through the ADR-0004 sanitized pipeline), the
 * SEO block (TS-282-followup-1 `generateMetadata` source), the ordered byline,
 * and the comments config (when enabled).
 */
export const PublicBlogArticleSchema = z
  .object({
    slug: PublicSlugSchema,
    title: PublicTitleSchema,
    /** Canonical Markdown of the LIVE (head) version. */
    body: PublicBodySchema,
    publishedAt: PublicTimestampSchema,
    category: PublicBlogCategorySchema.nullable(),
    seo: ArticleSeoSchema,
    /** Ordered byline (position 0 first). Empty = uncredited. */
    authors: z.array(PublicBlogAuthorSchema),
    comments: PublicBlogCommentsSchema.nullable(),
  })
  .strict();
export type PublicBlogArticle = z.infer<typeof PublicBlogArticleSchema>;

// ─── Query / responses ──────────────────────────────────────────────────

/**
 * `GET /api/v1/content/blog/articles` query — `page` (1-based) + optional
 * `category` (a category SLUG, the public filter key). Page size is the fixed
 * server-side `PUBLIC_BLOG_PAGE_SIZE`, deliberately not a client knob.
 */
export const ListPublicBlogArticlesQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(PUBLIC_BLOG_PAGE_MAX).default(1),
    category: z
      .string()
      .trim()
      .min(1)
      .max(CONTENT_HELP_CATEGORY_SLUG_MAX_LENGTH)
      .regex(CONTENT_HELP_CATEGORY_SLUG_REGEX)
      .optional(),
  })
  .strict();
export type ListPublicBlogArticlesQuery = z.infer<typeof ListPublicBlogArticlesQuerySchema>;

/**
 * The `/blog` index payload: one page of published articles (newest
 * `publishedAt` first), paging facts for link-based pagination, and the
 * distinct categories in use across published posts (the filter bar) — one
 * round trip for the whole index page.
 */
export const PublicBlogArticlesListResponseSchema = z
  .object({
    articles: z.array(PublicBlogArticleListItemSchema),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    totalArticles: z.number().int().min(0),
    totalPages: z.number().int().min(0),
    categories: z.array(PublicBlogCategorySchema),
  })
  .strict();
export type PublicBlogArticlesListResponse = z.infer<typeof PublicBlogArticlesListResponseSchema>;

export const PublicBlogArticleResponseSchema = z
  .object({ article: PublicBlogArticleSchema })
  .strict();
export type PublicBlogArticleResponse = z.infer<typeof PublicBlogArticleResponseSchema>;
