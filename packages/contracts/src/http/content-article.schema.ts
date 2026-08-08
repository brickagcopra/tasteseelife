import { z } from 'zod';

import { ContentStatusSchema } from './content-page.schema';
import { MediaAssetKeySchema, StoredMediaAssetKeySchema } from './media.schema';

/**
 * Blog / help-article CMS admin HTTP DTOs (TS-284-followup-3; PRD §10.10,
 * §10.11; PDD §19).
 *
 * The authenticated content-admin surface over the `service-content` article
 * aggregate — an `articles` row and its append-only `article_versions` history
 * (two `content`-schema tables). Blog posts and help-center articles live here;
 * every saved revision is retained and remains individually addressable by id.
 * An article optionally belongs to a `help_categories` node (`categoryId`).
 *
 * **Authoring vs. publishing.** Authoring (create an article, append a version,
 * set its category) is gated on `content:edit`; flipping a version live — the
 * `publish` action that stamps `effectiveAt` and moves the article's rendered
 * head — is gated on `content:publish`. Reads are gated on `content:read`.
 *
 * **Platform-wide inventory.** An article carries no per-household tenant axis —
 * it is content-staff-managed editorial inventory (the `Article` /
 * `ArticleVersion` Prisma models sit in service-content's `unscopedModels`,
 * mirroring `Page` / `PageVersion`).
 *
 * **Append-only history.** An `article_versions` row is never updated in place —
 * each save is a new row with a monotonically-increasing `versionNo`. The live
 * `articles.currentVersionId` soft pointer selects the rendered head; `publish`
 * repoints it. This schema deliberately mirrors `content-page.schema.ts` 1:1
 * (the page aggregate is the canonical shape); the only structural addition is
 * the optional `categoryId`.
 *
 * **`.strict()` everywhere** — an unknown field is a 400 (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped article / version / category row id cap. */
export const CONTENT_ARTICLE_ID_MAX_LENGTH = 36;

/** URL-addressable article slug. Lowercase kebab-case. */
export const CONTENT_ARTICLE_SLUG_MAX_LENGTH = 160;
export const CONTENT_ARTICLE_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Editorial title (per-article + per-version). */
export const CONTENT_ARTICLE_TITLE_MAX_LENGTH = 300;

/** Rendered body (Markdown / serialized rich-text). Generous but bounded. */
export const CONTENT_ARTICLE_BODY_MAX_LENGTH = 200_000;

/** Soft-FK authoring staff user id (into service-identity). */
export const CONTENT_ARTICLE_CREATED_BY_MAX_LENGTH = 64;

/** Admin articles-list caps. Bounded, no cursor at Phase-1 catalog volume. */
export const CONTENT_ARTICLES_LIST_LIMIT_DEFAULT = 50;
export const CONTENT_ARTICLES_LIST_LIMIT_MAX = 200;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONTENT_ARTICLE_ID_MAX_LENGTH);
const SlugSchema = z
  .string()
  .trim()
  .min(1, 'a slug is required')
  .max(CONTENT_ARTICLE_SLUG_MAX_LENGTH)
  .regex(
    CONTENT_ARTICLE_SLUG_REGEX,
    'slug must be lowercase kebab-case (a-z, 0-9, hyphen-separated)',
  );
const TitleSchema = z
  .string()
  .trim()
  .min(1, 'a title is required')
  .max(CONTENT_ARTICLE_TITLE_MAX_LENGTH);
const BodySchema = z.string().min(1, 'a body is required').max(CONTENT_ARTICLE_BODY_MAX_LENGTH);
const CreatedBySchema = z.string().min(1).max(CONTENT_ARTICLE_CREATED_BY_MAX_LENGTH);
const CategoryIdSchema = z.string().min(1).max(CONTENT_ARTICLE_ID_MAX_LENGTH);
const VersionNoSchema = z.number().int().positive();
const TimestampSchema = z.string().datetime({ offset: true });

// ─── Record shapes ──────────────────────────────────────────────────────

/**
 * An append-only saved revision of an article. `effectiveAt` is null until the
 * version is published; a published-then-superseded version keeps its
 * historical `effectiveAt`.
 */
export const ArticleVersionRecordSchema = z
  .object({
    id: IdSchema,
    articleId: IdSchema,
    versionNo: VersionNoSchema,
    title: TitleSchema,
    body: BodySchema,
    effectiveAt: TimestampSchema.nullable(),
    createdBy: CreatedBySchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ArticleVersionRecord = z.infer<typeof ArticleVersionRecordSchema>;

/**
 * Full article record (shallow — no nested versions). `categoryId` is the
 * optional `help_categories` node the article belongs to (null = uncategorised
 * blog post). `currentVersionId` is the soft pointer to the live version row
 * (null for an article with no version / never published).
 */
export const ArticleRecordSchema = z
  .object({
    id: IdSchema,
    slug: SlugSchema,
    status: ContentStatusSchema,
    title: TitleSchema,
    categoryId: IdSchema.nullable(),
    currentVersionId: IdSchema.nullable(),
    /**
     * When this post was sent to the newsletter (TS-288), or null if never
     * sent. Set once by the "send to newsletter" action; the double-send guard.
     */
    newsletterSentAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ArticleRecord = z.infer<typeof ArticleRecordSchema>;

// ─── SEO metadata (TS-282) ──────────────────────────────────────────────

/**
 * SEO field caps. SEO lives on the ARTICLE (a stable per-article identity —
 * canonical URL, OpenGraph/Twitter cards), NOT per version: a canonical URL or
 * social card should not fork every time the body is revised (TS-282; PDD
 * §19.1). All SEO fields are individually optional/nullable — a fresh article
 * carries an all-null `seo` block until an editor fills it in.
 */
export const CONTENT_SEO_TITLE_MAX_LENGTH = 200;
export const CONTENT_SEO_DESCRIPTION_MAX_LENGTH = 500;
/** Meta description — search-snippet copy. Bounded shorter than OG/Twitter. */
export const CONTENT_SEO_META_DESCRIPTION_MAX_LENGTH = 320;
export const CONTENT_SEO_URL_MAX_LENGTH = 2048;
/** Social-card image is a media assetKey reference (nullable), like ad creatives. */
/**
 * @deprecated TS-282-followup-5a — an assetKey is a media asset id, bounded by
 * `MEDIA_ID_MAX_LENGTH` (64). This 256 was a local invention that never
 * matched the media side; retained only so an existing import still resolves.
 */
export const CONTENT_SEO_IMAGE_KEY_MAX_LENGTH = 256;
/** Serialized JSON-LD byte cap — a bounded structured-data blob, not a document. */
export const CONTENT_SEO_JSON_LD_MAX_BYTES = 32_768;

/** Twitter card type — the two card layouts the platform emits. */
export const TWITTER_CARD_TYPES = ['summary', 'summary_large_image'] as const;
export const TwitterCardSchema = z.enum(TWITTER_CARD_TYPES);
export type TwitterCard = z.infer<typeof TwitterCardSchema>;

const SeoTitleSchema = z.string().trim().min(1).max(CONTENT_SEO_TITLE_MAX_LENGTH);
const SeoDescriptionSchema = z.string().trim().min(1).max(CONTENT_SEO_DESCRIPTION_MAX_LENGTH);
const MetaDescriptionSchema = z.string().trim().min(1).max(CONTENT_SEO_META_DESCRIPTION_MAX_LENGTH);
const CanonicalUrlSchema = z
  .string()
  .trim()
  .url('must be an absolute http(s) URL')
  .max(CONTENT_SEO_URL_MAX_LENGTH)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'must use the http or https scheme' });
/**
 * TS-282-followup-5a — a social-card image key is a `media_assets.id`. WRITE
 * paths use the shared schema; the stored SEO block keeps the permissive
 * bound so an article saved before the convention still reads.
 */
const ImageKeySchema = MediaAssetKeySchema;
const StoredImageKeySchema = StoredMediaAssetKeySchema;
/**
 * JSON-LD structured data — a JSON object (schema.org node). Rejected if it is
 * an array or primitive, or if the serialized form exceeds the byte cap. Stored
 * verbatim as Postgres `jsonb` and re-emitted in a `<script type="application/
 * ld+json">` by the public read surface (TS-282-followup-1).
 */
const JsonLdSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => Buffer.byteLength(JSON.stringify(v), 'utf8') <= CONTENT_SEO_JSON_LD_MAX_BYTES, {
    message: `JSON-LD exceeds ${CONTENT_SEO_JSON_LD_MAX_BYTES} bytes`,
  });

/**
 * The per-article SEO block. Every field is nullable — null means "not set"
 * (the surface falls back to the article's own title / rendered content). Read
 * back on the article-detail hydration; written via the SEO PATCH.
 */
export const ArticleSeoSchema = z
  .object({
    seoTitle: SeoTitleSchema.nullable(),
    metaDescription: MetaDescriptionSchema.nullable(),
    canonicalUrl: CanonicalUrlSchema.nullable(),
    ogTitle: SeoTitleSchema.nullable(),
    ogDescription: SeoDescriptionSchema.nullable(),
    ogImageKey: StoredImageKeySchema.nullable(),
    twitterCard: TwitterCardSchema.nullable(),
    twitterTitle: SeoTitleSchema.nullable(),
    twitterDescription: SeoDescriptionSchema.nullable(),
    twitterImageKey: StoredImageKeySchema.nullable(),
    jsonLd: JsonLdSchema.nullable(),
  })
  .strict();
export type ArticleSeo = z.infer<typeof ArticleSeoSchema>;

/**
 * `PATCH /api/v1/admin/content/articles/:articleId/seo` body — update SEO
 * metadata. Every field is optional; a supplied `null` CLEARS that field, an
 * omitted field leaves it unchanged (partial-update semantics, mirroring the
 * metadata PATCH). At least one field must be present.
 */
export const UpdateArticleSeoRequestSchema = z
  .object({
    seoTitle: SeoTitleSchema.nullable().optional(),
    metaDescription: MetaDescriptionSchema.nullable().optional(),
    canonicalUrl: CanonicalUrlSchema.nullable().optional(),
    ogTitle: SeoTitleSchema.nullable().optional(),
    ogDescription: SeoDescriptionSchema.nullable().optional(),
    ogImageKey: ImageKeySchema.nullable().optional(),
    twitterCard: TwitterCardSchema.nullable().optional(),
    twitterTitle: SeoTitleSchema.nullable().optional(),
    twitterDescription: SeoDescriptionSchema.nullable().optional(),
    twitterImageKey: ImageKeySchema.nullable().optional(),
    jsonLd: JsonLdSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'at least one SEO field must be supplied',
  });
export type UpdateArticleSeoRequest = z.infer<typeof UpdateArticleSeoRequestSchema>;

// ─── Comments configuration (TS-289) ────────────────────────────────────

/**
 * Per-post comments config (TS-289; PDD §19.1). Comments render on the public
 * blog post (the carved embed, TS-289-followup-1); this block is the per-post
 * configuration the embed reads. The platform default is Disqus (the PDD
 * default); moderation routes to `service-trust-safety` (the carved webhook,
 * TS-289-followup-2).
 */
export const CONTENT_DISQUS_IDENTIFIER_MAX_LENGTH = 256;

/**
 * Comments backend for a post. `disqus` (the PDD default embed) or `none`
 * (comments off for this post regardless of `enabled`). Room for a future
 * `self_hosted` value without a breaking change (additive enum).
 */
export const ARTICLE_COMMENTS_PROVIDERS = ['disqus', 'none'] as const;
export const ArticleCommentsProviderSchema = z.enum(ARTICLE_COMMENTS_PROVIDERS);
export type ArticleCommentsProvider = z.infer<typeof ArticleCommentsProviderSchema>;

const DisqusIdentifierSchema = z.string().trim().min(1).max(CONTENT_DISQUS_IDENTIFIER_MAX_LENGTH);

/**
 * The per-article comments block. `enabled` is the per-post on/off toggle;
 * `provider` selects the backend; `disqusIdentifier` is the stable per-thread
 * Disqus identifier — null means the public embed falls back to the article
 * slug/id (a consumer concern). Read back on the article-detail hydration;
 * written via the comments PATCH.
 */
export const ArticleCommentsSchema = z
  .object({
    enabled: z.boolean(),
    provider: ArticleCommentsProviderSchema,
    disqusIdentifier: DisqusIdentifierSchema.nullable(),
  })
  .strict();
export type ArticleComments = z.infer<typeof ArticleCommentsSchema>;

/**
 * `PATCH /api/v1/admin/content/articles/:articleId/comments` body — partial
 * update of the comments config. Every field is optional; a supplied
 * `disqusIdentifier: null` CLEARS it, an omitted field leaves it unchanged
 * (partial-update semantics, mirroring the SEO PATCH). At least one field must
 * be present.
 */
export const UpdateArticleCommentsRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: ArticleCommentsProviderSchema.optional(),
    disqusIdentifier: DisqusIdentifierSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (v) => v.enabled !== undefined || v.provider !== undefined || v.disqusIdentifier !== undefined,
    {
      message: 'at least one comments field (enabled, provider, disqusIdentifier) must be supplied',
    },
  );
export type UpdateArticleCommentsRequest = z.infer<typeof UpdateArticleCommentsRequestSchema>;

/**
 * Article record WITH its version history (newest-first), its SEO block, AND
 * its comments config. Returned by
 * `GET /api/v1/admin/content/articles/:articleId` (the article-editor hydration).
 */
export const ArticleDetailSchema = ArticleRecordSchema.extend({
  versions: z.array(ArticleVersionRecordSchema),
  seo: ArticleSeoSchema,
  comments: ArticleCommentsSchema,
}).strict();
export type ArticleDetail = z.infer<typeof ArticleDetailSchema>;

// ─── Create article ─────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/articles` body — create an article shell. An
 * article is created in `draft` with no version; the first renderable revision
 * is added via the append-version endpoint and goes live via `publish`. `slug`
 * must be unique across articles (a collision is a 409). `categoryId` is
 * optional; when supplied it must resolve to an existing help category (a miss
 * is a 404).
 */
export const CreateArticleRequestSchema = z
  .object({
    slug: SlugSchema,
    title: TitleSchema,
    categoryId: CategoryIdSchema.optional(),
  })
  .strict();
export type CreateArticleRequest = z.infer<typeof CreateArticleRequestSchema>;

// ─── Update article metadata ────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/content/articles/:articleId` body — update editorial
 * metadata (title, category assignment). Body-level fields are all optional;
 * `categoryId: null` clears the category (uncategorise), an omitted `categoryId`
 * leaves it unchanged. Does NOT touch versions or the publication lifecycle.
 * At least one field must be present.
 */
export const UpdateArticleRequestSchema = z
  .object({
    title: TitleSchema.optional(),
    categoryId: CategoryIdSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.categoryId !== undefined, {
    message: 'at least one field (title, categoryId) must be supplied',
  });
export type UpdateArticleRequest = z.infer<typeof UpdateArticleRequestSchema>;

// ─── Append version ─────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/articles/:articleId/versions` body — append a new
 * revision. `versionNo` is assigned server-side (monotonic per article). The
 * version is NOT live on creation; `publish` stamps `effectiveAt`.
 */
export const CreateArticleVersionRequestSchema = z
  .object({
    title: TitleSchema,
    body: BodySchema,
  })
  .strict();
export type CreateArticleVersionRequest = z.infer<typeof CreateArticleVersionRequestSchema>;

// ─── Publish version ────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/articles/:articleId/versions/:versionId/publish`
 * body — flip a version live. Sets the version's `effectiveAt`, repoints the
 * article's `currentVersionId`, and moves the article to `published`.
 * `effectiveAt` is optional — omitted means "effective now"; supplied means a
 * future / backdated effective date. The body may be empty (`{}`).
 */
export const PublishArticleVersionRequestSchema = z
  .object({
    effectiveAt: TimestampSchema.optional(),
  })
  .strict();
export type PublishArticleVersionRequest = z.infer<typeof PublishArticleVersionRequestSchema>;

// ─── List ───────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/content/articles` query. With no filter the list returns
 * all articles ordered by `createdAt` descending. `status` and `categoryId`
 * narrow the result.
 */
export const ListArticlesQuerySchema = z
  .object({
    status: ContentStatusSchema.optional(),
    categoryId: CategoryIdSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONTENT_ARTICLES_LIST_LIMIT_MAX)
      .default(CONTENT_ARTICLES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListArticlesQuery = z.infer<typeof ListArticlesQuerySchema>;

// ─── Response envelopes ─────────────────────────────────────────────────

/** Single-article envelope returned by create / update / publish. */
export const ArticleResponseSchema = z.object({ article: ArticleRecordSchema }).strict();
export type ArticleResponse = z.infer<typeof ArticleResponseSchema>;

/** Article-detail envelope returned by `GET .../articles/:articleId`. */
export const ArticleDetailResponseSchema = z.object({ article: ArticleDetailSchema }).strict();
export type ArticleDetailResponse = z.infer<typeof ArticleDetailResponseSchema>;

/** `GET /api/v1/admin/content/articles` response — the matching articles. */
export const ArticlesListResponseSchema = z
  .object({ articles: z.array(ArticleRecordSchema) })
  .strict();
export type ArticlesListResponse = z.infer<typeof ArticlesListResponseSchema>;

/** Single-version envelope returned by append + the single-version GET. */
export const ArticleVersionResponseSchema = z
  .object({ version: ArticleVersionRecordSchema })
  .strict();
export type ArticleVersionResponse = z.infer<typeof ArticleVersionResponseSchema>;

/** SEO envelope (`{ seo }`) returned by the SEO PATCH (TS-282). */
export const ArticleSeoResponseSchema = z.object({ seo: ArticleSeoSchema }).strict();
export type ArticleSeoResponse = z.infer<typeof ArticleSeoResponseSchema>;

/** Comments-config envelope (`{ comments }`) returned by the comments PATCH (TS-289). */
export const ArticleCommentsResponseSchema = z.object({ comments: ArticleCommentsSchema }).strict();
export type ArticleCommentsResponse = z.infer<typeof ArticleCommentsResponseSchema>;

// ─── Send to newsletter (TS-288) ─────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/articles/:articleId/newsletter` body — trigger a
 * per-post newsletter send (`content:publish`). The send takes no input beyond
 * the path id (the recipient list is resolved downstream by the consumer), so
 * the body is empty (`{}`). Modeled as an explicit empty `.strict()` object so
 * any smuggled field is a 400. Only a PUBLISHED, not-yet-sent article can be
 * sent (409 otherwise).
 */
export const SendArticleNewsletterRequestSchema = z.object({}).strict();
export type SendArticleNewsletterRequest = z.infer<typeof SendArticleNewsletterRequestSchema>;

/**
 * `{ newsletterSentAt }` envelope returned by the send action — the timestamp
 * the post was marked sent (non-null; it was just stamped).
 */
export const SendArticleNewsletterResponseSchema = z
  .object({ newsletterSentAt: TimestampSchema })
  .strict();
export type SendArticleNewsletterResponse = z.infer<typeof SendArticleNewsletterResponseSchema>;
