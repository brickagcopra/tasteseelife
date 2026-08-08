import { z } from 'zod';

/**
 * Content / legal domain event (TS-285; PRD §10.11; PDD §19.2).
 *
 * `content.page.material_changed` — emitted by `service-content` when an editor
 * publishes a legal / static `page_version` that they have flagged as a
 * **material change** (a substantive change to Terms / Privacy / etc. that
 * subscribers must be told about, and — for Terms / Privacy — re-acknowledge).
 *
 * **Why an event, not a direct call.** The publish is the state change; the
 * "tell every subscriber + capture consent re-acknowledgment" fan-out is a
 * separate, cross-service concern (`service-notification` for the email +
 * in-app banner; an identity/household consent-ledger for the re-ack). The
 * producer appends this event to its outbox *inside the same Prisma transaction
 * as the publish* (PDD §7.3 / CLAUDE.md §5.3 outbox pattern), so the
 * notification signal commits atomically with the version going live — a
 * material change can never go live without its notification being durably
 * queued, and a rolled-back publish never emits a spurious notice.
 *
 * The relay (`worker-outbox-relay`) drains `content.outbox_events` onto Redis
 * Streams; the consumer (`service-notification`, TS-285-followup-1) is idempotent
 * on `eventId`. Only a MATERIAL publish emits this; an ordinary publish emits
 * just the `audit.action_recorded` trail.
 *
 * **No PII.** This is a content event — it names the page + version + the
 * editor's change note, never a subscriber. The per-recipient fan-out is the
 * consumer's job.
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The constant is the
 * single source of truth — services import the literal, so a rename is a TS
 * error at every call site.
 */
export const CONTENT_PAGE_MATERIAL_CHANGED = 'content.page.material_changed' as const;

/** Soft-FK page / version row id cap (CUID-shaped). Mirrors the http DTO. */
export const CONTENT_LEGAL_EVENT_ID_MAX_LENGTH = 36;
/** URL slug cap — mirrors `CONTENT_PAGE_SLUG_MAX_LENGTH` in the http DTO. */
export const CONTENT_LEGAL_EVENT_SLUG_MAX_LENGTH = 160;
/**
 * Editor's material-change note cap — the human summary of what changed / why
 * it is material. Bounded so a single publish can't pin an unbounded string on
 * the bus (CLAUDE.md §3.3). Mirrors the http `MaterialChangeNote` cap.
 */
export const CONTENT_LEGAL_EVENT_NOTE_MAX_LENGTH = 2_000;

/**
 * Common event envelope — every event carries `eventId` (consumer dedup key per
 * CLAUDE.md §5.3) and `occurredAt` (producer wall-clock timestamp). Same shape
 * as the audit / booking / search events.
 */
const ContentLegalEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * `content.page.material_changed` payload (TS-285).
 *
 *   - `pageId` / `pageVersionId` — the page + the specific published version
 *     that carries the material change. Soft ids into `content.pages` /
 *     `content.page_versions`.
 *   - `slug` — the page's URL slug (`privacy`, `terms`, …) so the consumer can
 *     deep-link the notification to the affected page without a lookup.
 *   - `versionNo` — the published version's monotonic revision number.
 *   - `effectiveAt` — when the version became (or is scheduled to become) the
 *     legally-effective copy (ISO-8601). Drives "effective on <date>" copy and
 *     any consent-reacknowledgment deadline.
 *   - `materialChangeNote` — the editor's summary of what changed / why it is
 *     material. Null when the editor flagged the change but left no note.
 */
export const ContentPageMaterialChangedSchema = ContentLegalEventEnvelopeSchema.extend({
  pageId: z.string().min(1).max(CONTENT_LEGAL_EVENT_ID_MAX_LENGTH),
  pageVersionId: z.string().min(1).max(CONTENT_LEGAL_EVENT_ID_MAX_LENGTH),
  slug: z.string().min(1).max(CONTENT_LEGAL_EVENT_SLUG_MAX_LENGTH),
  versionNo: z.number().int().positive(),
  effectiveAt: z.string().datetime({ offset: true }),
  materialChangeNote: z.string().min(1).max(CONTENT_LEGAL_EVENT_NOTE_MAX_LENGTH).nullable(),
}).strict();
export type ContentPageMaterialChanged = z.infer<typeof ContentPageMaterialChangedSchema>;
