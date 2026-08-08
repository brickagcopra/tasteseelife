import { z } from 'zod';

/**
 * Content newsletter domain event (TS-288; PRD §10.10; PDD §12.3).
 *
 * `content.newsletter.send_requested` — emitted by `service-content` when an
 * editor triggers "send to newsletter" on a **published** article. It is the
 * seam between the CMS publish/send action and the marketing-email fan-out.
 *
 * **Why an event, not a direct call.** The "send" is a content-side state change
 * (stamp `newsletter_sent_at`, the double-send guard); the actual "deliver this
 * post to every opt-in newsletter subscriber, marketing category, honoring the
 * CAN-SPAM opt-out + unsubscribe" fan-out is a separate, cross-service concern
 * owned by `service-notification` (TS-288-followup-1) over its subscriber /
 * preference model (TS-288-followup-2). The producer appends this event to its
 * outbox *inside the same Prisma transaction as the send guard* (PDD §7.3 /
 * CLAUDE.md §5.3 outbox pattern), so a post marked "sent" is guaranteed to have
 * durably queued its delivery signal, and a rolled-back send never emits a
 * spurious blast. The relay (`worker-outbox-relay`) already drains
 * `content.outbox_events` (TS-284) — a new event NAME on the same table needs no
 * relay-config change. The consumer is idempotent on `eventId`; the
 * `newsletter_sent_at` guard is the second line of defence against a re-send.
 *
 * **No subscriber PII.** The event names the article (id / slug / title / lead
 * copy) + the requesting staff id — never a recipient. The consumer resolves the
 * opt-in recipient list itself.
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The constant is the
 * single source of truth — services import the literal, so a rename is a TS error
 * at every call site.
 */
export const CONTENT_NEWSLETTER_SEND_REQUESTED = 'content.newsletter.send_requested' as const;

/** Soft id cap (CUID-shaped) — mirrors `CONTENT_ARTICLE_ID_MAX_LENGTH`. */
export const CONTENT_NEWSLETTER_EVENT_ID_MAX_LENGTH = 36;
/** URL slug cap — mirrors `CONTENT_ARTICLE_SLUG_MAX_LENGTH`. */
export const CONTENT_NEWSLETTER_EVENT_SLUG_MAX_LENGTH = 160;
/** Title cap — mirrors `CONTENT_ARTICLE_TITLE_MAX_LENGTH`. */
export const CONTENT_NEWSLETTER_EVENT_TITLE_MAX_LENGTH = 300;
/** Lead/excerpt cap — a bounded plain-text-ish lead for the email preview. */
export const CONTENT_NEWSLETTER_EVENT_EXCERPT_MAX_LENGTH = 400;
/** SEO title cap — mirrors `CONTENT_SEO_TITLE_MAX_LENGTH`. */
export const CONTENT_NEWSLETTER_EVENT_SEO_TITLE_MAX_LENGTH = 200;
/** Meta-description cap — mirrors `CONTENT_SEO_META_DESCRIPTION_MAX_LENGTH`. */
export const CONTENT_NEWSLETTER_EVENT_META_DESCRIPTION_MAX_LENGTH = 320;
/** Soft-FK requesting staff user id cap — mirrors `CONTENT_ARTICLE_CREATED_BY_MAX_LENGTH`. */
export const CONTENT_NEWSLETTER_EVENT_REQUESTED_BY_MAX_LENGTH = 64;

/**
 * Common event envelope — every event carries `eventId` (consumer dedup key per
 * CLAUDE.md §5.3) and `occurredAt` (producer wall-clock timestamp). Same shape
 * as the audit / booking / content-search events.
 */
const ContentNewsletterEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * `content.newsletter.send_requested` payload (TS-288) — the marketing-email
 * source facts for a single published post.
 *
 *   - `articleId` / `slug` — the post's id + its public URL slug (the email CTA
 *     deep-links the slug).
 *   - `title` — the published version's title (the email subject / headline).
 *   - `excerpt` — a bounded plain-text-ish lead derived from the body (a simple
 *     truncate at the producer; a richer preview is a consumer refinement). Null
 *     when the body is empty.
 *   - `seoTitle` / `metaDescription` — SEO overrides, if set, so the consumer can
 *     prefer them for the email subject / preview. Null when unset.
 *   - `publishedAt` — when the current version became effective (ISO-8601 w/
 *     offset).
 *   - `requestedByUserId` — the soft-ref staff id who triggered the send (for
 *     the consumer's send-provenance / audit trail; never a recipient).
 */
export const ContentNewsletterSendRequestedSchema = ContentNewsletterEventEnvelopeSchema.extend({
  articleId: z.string().min(1).max(CONTENT_NEWSLETTER_EVENT_ID_MAX_LENGTH),
  slug: z.string().min(1).max(CONTENT_NEWSLETTER_EVENT_SLUG_MAX_LENGTH),
  title: z.string().min(1).max(CONTENT_NEWSLETTER_EVENT_TITLE_MAX_LENGTH),
  excerpt: z.string().max(CONTENT_NEWSLETTER_EVENT_EXCERPT_MAX_LENGTH).nullable(),
  seoTitle: z.string().min(1).max(CONTENT_NEWSLETTER_EVENT_SEO_TITLE_MAX_LENGTH).nullable(),
  metaDescription: z
    .string()
    .min(1)
    .max(CONTENT_NEWSLETTER_EVENT_META_DESCRIPTION_MAX_LENGTH)
    .nullable(),
  publishedAt: z.string().datetime({ offset: true }),
  requestedByUserId: z.string().min(1).max(CONTENT_NEWSLETTER_EVENT_REQUESTED_BY_MAX_LENGTH),
}).strict();
export type ContentNewsletterSendRequested = z.infer<typeof ContentNewsletterSendRequestedSchema>;
