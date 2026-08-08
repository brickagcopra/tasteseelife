import { z } from 'zod';
import { MediaAssetKeySchema, StoredMediaAssetKeySchema } from './media.schema';

/**
 * Author profiles + multi-author collaboration CMS admin HTTP DTOs (TS-283; PRD
 * §10.10; PDD §19.1).
 *
 * The authenticated content-admin surface over two `service-content` tables:
 *   - `content_authors`  — a content-staff user's public authoring identity
 *     (display name, bio, photo, social links), keyed by a UNIQUE soft `userId`
 *     reference into service-identity so the byline persists independently of
 *     account/role churn.
 *   - `article_authors`  — the ordered many-to-many byline credit linking an
 *     article to its authors (co-authorship = N credited authors, ordered).
 *
 * **Authoring vs. reads.** Creating / updating an author profile and setting an
 * article's authors are gated on `content:edit`; reads on `content:read`. There
 * is no publish lifecycle (a profile is a small mutable record).
 *
 * **Article authors as a sub-resource.** An article's byline is read/written via
 * `GET | PUT /api/v1/admin/content/articles/:articleId/authors` — a dedicated
 * sub-resource rather than being embedded in the article-detail payload (which
 * keeps the TS-284 `ArticleDetail` shape untouched). The `PUT` is a REPLACE-SET:
 * the supplied ordered list becomes the article's complete author set (idempotent;
 * `sortOrder` is assigned from array position).
 *
 * **Social links** are validated http/https URLs (the `javascript:`-rejecting
 * refine mirrors the TS-282 canonical-URL guard). **Platform-wide inventory** —
 * no per-household tenant axis (both models sit in service-content's
 * `unscopedModels`). **`.strict()` everywhere** — an unknown field is a 400
 * (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID-shaped author / article / link row id cap. */
export const CONTENT_AUTHOR_ID_MAX_LENGTH = 36;

/** Soft-FK service-identity user id cap (mirrors the audit/version author caps). */
export const CONTENT_AUTHOR_USER_ID_MAX_LENGTH = 64;

/** Public byline display name. */
export const CONTENT_AUTHOR_DISPLAY_NAME_MAX_LENGTH = 200;

/** Author biography (Markdown / plain text). Bounded but generous. */
export const CONTENT_AUTHOR_BIO_MAX_LENGTH = 4_000;

/** Profile photo assetKey reference (nullable), like ad creatives. */
/**
 * @deprecated TS-282-followup-5a — an assetKey is a media asset id, bounded by
 * `MEDIA_ID_MAX_LENGTH` (64). This 256 was a local invention that never
 * matched the media side; retained only so an existing import still resolves.
 */
export const CONTENT_AUTHOR_PHOTO_KEY_MAX_LENGTH = 256;

/** Per-social-link URL cap. */
export const CONTENT_AUTHOR_SOCIAL_URL_MAX_LENGTH = 2048;

/** Byline ordering cap (mirrors the help-category sort-order cap). */
export const CONTENT_AUTHOR_SORT_ORDER_MAX = 1_000_000;

/** Max co-authors creditable on a single article — a bounded byline. */
export const CONTENT_ARTICLE_AUTHORS_MAX = 20;

/** Admin authors-list caps. Bounded, no cursor at Phase-1 volume. */
export const CONTENT_AUTHORS_LIST_LIMIT_DEFAULT = 50;
export const CONTENT_AUTHORS_LIST_LIMIT_MAX = 200;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONTENT_AUTHOR_ID_MAX_LENGTH);
const UserIdSchema = z
  .string()
  .trim()
  .min(1, 'a userId is required')
  .max(CONTENT_AUTHOR_USER_ID_MAX_LENGTH);
const DisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'a display name is required')
  .max(CONTENT_AUTHOR_DISPLAY_NAME_MAX_LENGTH);
const BioSchema = z.string().trim().min(1).max(CONTENT_AUTHOR_BIO_MAX_LENGTH);
/**
 * TS-282-followup-5a — an author photo key is a `media_assets.id`, and the
 * shared schema is the single definition of that. WRITE paths only; the
 * record shape below keeps the permissive stored bound so an author row
 * written before the convention landed still reads.
 */
const PhotoAssetKeySchema = MediaAssetKeySchema;
const StoredPhotoAssetKeySchema = StoredMediaAssetKeySchema;
const SortOrderSchema = z.number().int().min(0).max(CONTENT_AUTHOR_SORT_ORDER_MAX);
const TimestampSchema = z.string().datetime({ offset: true });

/**
 * A single social URL — absolute http/https only. The `.refine` rejects
 * `javascript:` / `data:` and other non-web schemes `z.url()` would otherwise
 * accept (the TS-282 canonical-URL guard, applied to author social links).
 */
const SocialUrlSchema = z
  .string()
  .trim()
  .url('must be an absolute http(s) URL')
  .max(CONTENT_AUTHOR_SOCIAL_URL_MAX_LENGTH)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'must use the http or https scheme' });

/**
 * Author social links — a small fixed set of optional platforms, each an
 * http(s) URL. `.strict()` rejects unknown platform keys (an unknown link is a
 * 400, not silently stored). All keys optional; the object itself is nullable on
 * the record (null = none set).
 */
export const AuthorSocialLinksSchema = z
  .object({
    twitter: SocialUrlSchema.optional(),
    linkedin: SocialUrlSchema.optional(),
    github: SocialUrlSchema.optional(),
    website: SocialUrlSchema.optional(),
  })
  .strict();
export type AuthorSocialLinks = z.infer<typeof AuthorSocialLinksSchema>;

/** The credited-author role on an article byline. */
export const CONTENT_AUTHOR_ROLES = ['primary', 'co_author'] as const;
export const ContentAuthorRoleSchema = z.enum(CONTENT_AUTHOR_ROLES);
export type ContentAuthorRole = z.infer<typeof ContentAuthorRoleSchema>;

// ─── Author record ──────────────────────────────────────────────────────

/**
 * A content author profile. `userId` is the soft service-identity reference
 * (unique). Every free-text / media / social field is nullable — a fresh profile
 * carries just a `userId` + `displayName` until an editor fills the rest in.
 */
export const ContentAuthorRecordSchema = z
  .object({
    id: IdSchema,
    userId: UserIdSchema,
    displayName: DisplayNameSchema,
    bio: BioSchema.nullable(),
    photoAssetKey: StoredPhotoAssetKeySchema.nullable(),
    socialLinks: AuthorSocialLinksSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ContentAuthorRecord = z.infer<typeof ContentAuthorRecordSchema>;

// ─── Create author ──────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/content/authors` body — create an author profile. `userId`
 * must be unique across authors (a second profile for the same identity is a
 * 409). `displayName` is required; `bio` / `photoAssetKey` / `socialLinks` are
 * optional.
 */
export const CreateContentAuthorRequestSchema = z
  .object({
    userId: UserIdSchema,
    displayName: DisplayNameSchema,
    bio: BioSchema.optional(),
    photoAssetKey: PhotoAssetKeySchema.optional(),
    socialLinks: AuthorSocialLinksSchema.optional(),
  })
  .strict();
export type CreateContentAuthorRequest = z.infer<typeof CreateContentAuthorRequestSchema>;

// ─── Update author ──────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/content/authors/:authorId` body — update the profile. All
 * fields optional; at least one must be present. A supplied `null` on
 * `bio` / `photoAssetKey` / `socialLinks` CLEARS that field; an omitted field is
 * left unchanged. `userId` is immutable (the identity binding).
 */
export const UpdateContentAuthorRequestSchema = z
  .object({
    displayName: DisplayNameSchema.optional(),
    bio: BioSchema.nullable().optional(),
    photoAssetKey: PhotoAssetKeySchema.nullable().optional(),
    socialLinks: AuthorSocialLinksSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'at least one field (displayName, bio, photoAssetKey, socialLinks) must be supplied',
  });
export type UpdateContentAuthorRequest = z.infer<typeof UpdateContentAuthorRequestSchema>;

// ─── List authors ───────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/content/authors` query — all author profiles ordered by
 * `displayName`. Bounded by `limit`.
 */
export const ListContentAuthorsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONTENT_AUTHORS_LIST_LIMIT_MAX)
      .default(CONTENT_AUTHORS_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListContentAuthorsQuery = z.infer<typeof ListContentAuthorsQuerySchema>;

// ─── Article ↔ author credits (the byline) ──────────────────────────────

/**
 * One credited author on an article's byline — the full author record plus its
 * `role` and `sortOrder`. Returned (ordered by `sortOrder`) by the article-authors
 * read.
 */
export const ArticleAuthorSchema = z
  .object({
    role: ContentAuthorRoleSchema,
    sortOrder: SortOrderSchema,
    author: ContentAuthorRecordSchema,
  })
  .strict();
export type ArticleAuthor = z.infer<typeof ArticleAuthorSchema>;

/** One entry in a set-authors request — which author, in what role. */
export const SetArticleAuthorEntrySchema = z
  .object({
    authorId: IdSchema,
    role: ContentAuthorRoleSchema.default('co_author'),
  })
  .strict();
export type SetArticleAuthorEntry = z.infer<typeof SetArticleAuthorEntrySchema>;

/**
 * `PUT /api/v1/admin/content/articles/:articleId/authors` body — REPLACE the
 * article's complete ordered author set. `sortOrder` is assigned from array
 * position (index 0 first). An empty array clears the byline. `authorId`s must be
 * distinct (a duplicate is a 400) and each must resolve to an existing author (a
 * miss is a 404). Bounded to `CONTENT_ARTICLE_AUTHORS_MAX`. Idempotent — replaying
 * the same list is a no-op-equivalent replace.
 */
export const SetArticleAuthorsRequestSchema = z
  .object({
    authors: z.array(SetArticleAuthorEntrySchema).max(CONTENT_ARTICLE_AUTHORS_MAX),
  })
  .strict()
  .refine((v) => new Set(v.authors.map((a) => a.authorId)).size === v.authors.length, {
    message: 'authorId values must be distinct',
  });
export type SetArticleAuthorsRequest = z.infer<typeof SetArticleAuthorsRequestSchema>;

// ─── Response envelopes ─────────────────────────────────────────────────

/** Single-author envelope returned by create / update / detail. */
export const ContentAuthorResponseSchema = z.object({ author: ContentAuthorRecordSchema }).strict();
export type ContentAuthorResponse = z.infer<typeof ContentAuthorResponseSchema>;

/** `GET /api/v1/admin/content/authors` response — the author profiles. */
export const ContentAuthorsListResponseSchema = z
  .object({ authors: z.array(ContentAuthorRecordSchema) })
  .strict();
export type ContentAuthorsListResponse = z.infer<typeof ContentAuthorsListResponseSchema>;

/**
 * `GET | PUT /api/v1/admin/content/articles/:articleId/authors` response — the
 * article's ordered byline (each entry = author record + role + sortOrder).
 */
export const ArticleAuthorsResponseSchema = z
  .object({ authors: z.array(ArticleAuthorSchema) })
  .strict();
export type ArticleAuthorsResponse = z.infer<typeof ArticleAuthorsResponseSchema>;
