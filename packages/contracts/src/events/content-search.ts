import { z } from 'zod';

/**
 * Content search-indexing domain events (TS-286; PRD §10.11; PDD §14.2, §19.3).
 *
 * `service-content` emits these when an article's public searchability changes,
 * so the `worker-search-indexer` (TS-286-followup-1) can keep the `articles`
 * Elasticsearch index (TS-111) in sync:
 *
 *   - `content.article.published` — a version went live; the index doc should be
 *     upserted from the projection this event carries.
 *   - `content.article.unpublished` — the article left the published state
 *     (unpublish / archive, TS-281-followup-1); the index doc should be removed.
 *     Defined now so the indexer contract is complete; it begins firing once the
 *     unpublish path exists.
 *
 * **Fat projection, not a thin id (deviation from the provider seam — noted).**
 * The provider search events (`provider.profile_updated`, …) are THIN — they
 * carry only `providerId`, and the indexer re-fetches a full snapshot from
 * `service-provider` before projecting to ES. Content deviates: the published
 * article is fully materialised in `service-content` at publish time, so the
 * event carries the complete indexable projection and the (carved) indexer
 * consumer becomes a pure ES upsert — no snapshot round-trip, no internal
 * article-snapshot endpoint to build. The alternative (thin event + a
 * service-content snapshot client mirroring `provider-snapshot.client`) is a
 * valid future refactor if the projection grows heavy; recorded here for the
 * consumer follow-up.
 *
 * **Why an event, not a direct index call.** Publish is the state change; ES
 * indexing is a separate, eventually-consistent concern owned by the indexer
 * worker. The producer appends `content.article.published` to its outbox INSIDE
 * the same Prisma transaction as the publish (PDD §7.3 / CLAUDE.md §5.3 outbox
 * pattern), so a published article is guaranteed to have its index signal
 * durably queued, and a rolled-back publish never emits a spurious one. The
 * relay (`worker-outbox-relay`) already drains `content.outbox_events` (TS-284)
 * — a new event NAME on the same table needs no relay-config change. The
 * consumer is idempotent on `eventId`.
 *
 * **No PII.** Blog / help-article content is editorial, not personal; the
 * projection carries titles, body, slug, category + author *ids*, and SEO copy
 * — never a subscriber or senior.
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The constants are
 * the single source of truth — services import the literal, so a rename is a TS
 * error at every call site.
 */
export const CONTENT_ARTICLE_PUBLISHED = 'content.article.published' as const;
export const CONTENT_ARTICLE_UNPUBLISHED = 'content.article.unpublished' as const;

/** Soft id cap (CUID-shaped) — mirrors `CONTENT_ARTICLE_ID_MAX_LENGTH`. */
export const CONTENT_SEARCH_EVENT_ID_MAX_LENGTH = 36;
/** URL slug cap — mirrors `CONTENT_ARTICLE_SLUG_MAX_LENGTH`. */
export const CONTENT_SEARCH_EVENT_SLUG_MAX_LENGTH = 160;
/** Title cap — mirrors `CONTENT_ARTICLE_TITLE_MAX_LENGTH`. */
export const CONTENT_SEARCH_EVENT_TITLE_MAX_LENGTH = 300;
/** Body cap — mirrors `CONTENT_ARTICLE_BODY_MAX_LENGTH` (the full published Markdown). */
export const CONTENT_SEARCH_EVENT_BODY_MAX_LENGTH = 200_000;
/** Excerpt cap — a bounded plain-text-ish lead for the search result snippet. */
export const CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH = 400;
/** SEO title cap — mirrors `CONTENT_SEO_TITLE_MAX_LENGTH`. */
export const CONTENT_SEARCH_EVENT_SEO_TITLE_MAX_LENGTH = 200;
/** Meta-description cap — mirrors `CONTENT_SEO_META_DESCRIPTION_MAX_LENGTH`. */
export const CONTENT_SEARCH_EVENT_META_DESCRIPTION_MAX_LENGTH = 320;
/** Soft author-id cap — mirrors `CONTENT_SEARCH_EVENT_ID_MAX_LENGTH`. */
export const CONTENT_SEARCH_EVENT_AUTHOR_ID_MAX_LENGTH = 36;
/**
 * Max author ids carried on the projection. The byline is capped at 20 authors
 * per article (the TS-283 `PUT …/authors` replace-set cap); the event mirrors
 * that bound so a corrupt row can't pin an unbounded array on the bus.
 */
export const CONTENT_SEARCH_EVENT_AUTHOR_IDS_MAX = 20;

/**
 * Common event envelope — every event carries `eventId` (consumer dedup key per
 * CLAUDE.md §5.3) and `occurredAt` (producer wall-clock timestamp). Same shape
 * as the audit / booking / content-legal events.
 */
const ContentSearchEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * `content.article.published` payload (TS-286) — the ES-document source.
 *
 *   - `articleId` / `slug` — the index doc id + its public URL slug.
 *   - `title` — the PUBLISHED version's title (the searchable headline).
 *   - `excerpt` — a bounded plain-text-ish lead derived from the body (a simple
 *     truncate at the producer for the seam — a proper Markdown-strip is a
 *     consumer/indexer refinement). Null when the body is empty.
 *   - `body` — the full published Markdown (the searchable full text).
 *   - `categoryId` — the help-category the article sits under, or null.
 *   - `authorIds` — the ordered byline author ids (soft ids into
 *     `content.content_authors`); may be empty. Bounded at 20.
 *   - `seoTitle` / `metaDescription` — SEO overrides, if set, so the index can
 *     prefer them for the result title/snippet. Null when unset.
 *   - `publishedAt` — when the version became effective (ISO-8601 w/ offset).
 *   - `versionNo` — the published version's monotonic revision number.
 */
export const ContentArticlePublishedSchema = ContentSearchEventEnvelopeSchema.extend({
  articleId: z.string().min(1).max(CONTENT_SEARCH_EVENT_ID_MAX_LENGTH),
  slug: z.string().min(1).max(CONTENT_SEARCH_EVENT_SLUG_MAX_LENGTH),
  title: z.string().min(1).max(CONTENT_SEARCH_EVENT_TITLE_MAX_LENGTH),
  excerpt: z.string().max(CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH).nullable(),
  body: z.string().max(CONTENT_SEARCH_EVENT_BODY_MAX_LENGTH),
  categoryId: z.string().min(1).max(CONTENT_SEARCH_EVENT_ID_MAX_LENGTH).nullable(),
  authorIds: z
    .array(z.string().min(1).max(CONTENT_SEARCH_EVENT_AUTHOR_ID_MAX_LENGTH))
    .max(CONTENT_SEARCH_EVENT_AUTHOR_IDS_MAX),
  seoTitle: z.string().min(1).max(CONTENT_SEARCH_EVENT_SEO_TITLE_MAX_LENGTH).nullable(),
  metaDescription: z
    .string()
    .min(1)
    .max(CONTENT_SEARCH_EVENT_META_DESCRIPTION_MAX_LENGTH)
    .nullable(),
  publishedAt: z.string().datetime({ offset: true }),
  versionNo: z.number().int().positive(),
}).strict();
export type ContentArticlePublished = z.infer<typeof ContentArticlePublishedSchema>;

/**
 * `content.article.unpublished` payload (TS-286) — a tombstone signal so the
 * indexer removes the doc. Carries just the identity; there is nothing to
 * project. Fires once the unpublish/archive path exists (TS-281-followup-1).
 */
export const ContentArticleUnpublishedSchema = ContentSearchEventEnvelopeSchema.extend({
  articleId: z.string().min(1).max(CONTENT_SEARCH_EVENT_ID_MAX_LENGTH),
  slug: z.string().min(1).max(CONTENT_SEARCH_EVENT_SLUG_MAX_LENGTH),
}).strict();
export type ContentArticleUnpublished = z.infer<typeof ContentArticleUnpublishedSchema>;
