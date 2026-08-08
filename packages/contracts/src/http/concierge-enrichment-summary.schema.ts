import { z } from 'zod';

import {
  CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH,
  CONCIERGE_TICKET_ID_MAX_LENGTH,
  CONCIERGE_TICKET_USER_ID_MAX_LENGTH,
} from './concierge-ticket.schema';

/**
 * Tier-3 weekly enrichment-summary HTTP DTOs (TS-229; PRD §5.1 Tier 3, §6.9;
 * PDD §12.1).
 *
 * The dedicated concierge writes a short weekly narrative for a Tier-3
 * (Concierge Lifestyle) household — visit highlights, wellness signals, and
 * social engagement — and the family-portal dashboard surfaces the published
 * summaries (with a stable permalink per week). This is the white-glove
 * differentiator above the Tier-1/2 automated wellness check-in (PRD §6.9).
 *
 * Three surfaces share this contract:
 *
 *   1. **Admin ops** — `POST/GET/PATCH /api/v1/admin/concierge/enrichment-summaries`
 *      (+ `GET .../:summaryId`). The ops actor is global-scoped, so the create
 *      body carries the target `householdId`. Gated on `concierge:read` (reads)
 *      / `concierge:write` (mutations) — the same RBAC permissions TS-224 added
 *      (no new permission here).
 *
 *   2. **Family read** — `GET /api/v1/concierge/enrichment-summaries/me` (the
 *      household's PUBLISHED summaries, newest-week-first) +
 *      `GET /api/v1/concierge/enrichment-summaries/me/:summaryId` (the
 *      permalink target — one published summary). The actor token's
 *      `tenantScope: {type:'household', householdId}` claim resolves the
 *      household — no household id crosses the wire. Read-only.
 *
 * **Lifecycle (confirmed via AskUserQuestion 2026-05-26).** `draft` →
 * `published` → `archived`, all three mutually reachable (a concierge may
 * unpublish back to `draft` to correct, or re-publish an `archived` summary).
 * The family sees ONLY `published` summaries — a `draft` is the concierge's
 * private compose buffer and an `archived` summary is retired from the
 * dashboard. Publishing stamps `publishedAt` + `publishedByUserId`; archiving
 * stamps `archivedAt`.
 *
 * **Week-keyed (confirmed via AskUserQuestion 2026-05-26).** Each summary is
 * anchored to a Monday `weekStartDate` (a `YYYY-MM-DD` calendar date that MUST
 * be a Monday); a household has at most one non-deleted summary per week
 * (enforced by a DB partial-unique index). The Monday requirement canonicalises
 * the week key so two writers cannot create rival summaries for "the same week"
 * under different in-week dates.
 *
 * **Email-on-publish is deferred** to a TS-229 follow-up — service-concierge
 * has no outbox/event wiring yet (the same deferral as every concierge task's
 * domain events). The permalink + dashboard read ship now; the
 * `concierge.enrichment_summary_published` → `service-notification` hop follows.
 *
 * **`.strict()` everywhere** — a typo in a field name is a 400, not a
 * silently-dropped knob (CLAUDE.md §3.3).
 */

// ─── Bounded length / numeric constants ─────────────────────────────────

/** CUID/CUID2-shaped summary-row id cap. */
export const CONCIERGE_ENRICHMENT_SUMMARY_ID_MAX_LENGTH = CONCIERGE_TICKET_ID_MAX_LENGTH;

/** Soft-FK household id cap — matches `household.households.id`. */
export const CONCIERGE_ENRICHMENT_SUMMARY_HOUSEHOLD_ID_MAX_LENGTH =
  CONCIERGE_TICKET_HOUSEHOLD_ID_MAX_LENGTH;

/** Soft-FK user id cap — matches `identity.users.id`. */
export const CONCIERGE_ENRICHMENT_SUMMARY_USER_ID_MAX_LENGTH = CONCIERGE_TICKET_USER_ID_MAX_LENGTH;

/** Short headline shown on the family dashboard card + the ops list. */
export const CONCIERGE_ENRICHMENT_HEADLINE_MAX_LENGTH = 200;

/**
 * Each of the three narrative sections (visit highlights / wellness signals /
 * social engagement) is a free-text block.
 */
export const CONCIERGE_ENRICHMENT_SECTION_MAX_LENGTH = 4000;

/** Optional closing notes block. */
export const CONCIERGE_ENRICHMENT_NOTES_MAX_LENGTH = 4000;

/**
 * List caps. Bounded, no cursor (Phase 1 — followup). Default ~half a year of
 * weekly summaries; max ~two years.
 */
export const CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_DEFAULT = 26;
export const CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_MAX = 104;

// ─── Enums ──────────────────────────────────────────────────────────────

/**
 * Enrichment-summary lifecycle — mirrors the
 * `ConciergeEnrichmentSummaryStatus` Prisma enum.
 *
 *   `draft`     = the concierge's private compose buffer; NOT family-visible.
 *   `published` = visible on the family dashboard + at its permalink. Stamps
 *                 `publishedAt` + `publishedByUserId`.
 *   `archived`  = retired from the family view (e.g. superseded / written in
 *                 error). Re-publishable. Stamps `archivedAt`.
 */
export const ConciergeEnrichmentSummaryStatusSchema = z.enum(['draft', 'published', 'archived']);
export type ConciergeEnrichmentSummaryStatus = z.infer<
  typeof ConciergeEnrichmentSummaryStatusSchema
>;

/**
 * Allowed status transitions. All three states are mutually reachable — there
 * is no terminal state (an `archived` summary can be re-published). A
 * self-transition is NOT a transition (the service treats `status === current`
 * as a no-op), so each state maps only to the OTHER two.
 */
export const CONCIERGE_ENRICHMENT_SUMMARY_STATUS_TRANSITIONS: Readonly<
  Record<ConciergeEnrichmentSummaryStatus, readonly ConciergeEnrichmentSummaryStatus[]>
> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft', 'published'],
};

/** `true` when `from → to` is an allowed (distinct) status transition. */
export function canTransitionConciergeEnrichmentSummary(
  from: ConciergeEnrichmentSummaryStatus,
  to: ConciergeEnrichmentSummaryStatus,
): boolean {
  return CONCIERGE_ENRICHMENT_SUMMARY_STATUS_TRANSITIONS[from].includes(to);
}

/** `true` when a summary in this status is visible to the family. */
export function isConciergeEnrichmentSummaryFamilyVisible(
  status: ConciergeEnrichmentSummaryStatus,
): boolean {
  return status === 'published';
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(CONCIERGE_ENRICHMENT_SUMMARY_ID_MAX_LENGTH);
const HouseholdIdSchema = z
  .string()
  .min(1)
  .max(CONCIERGE_ENRICHMENT_SUMMARY_HOUSEHOLD_ID_MAX_LENGTH);
const UserIdSchema = z.string().min(1).max(CONCIERGE_ENRICHMENT_SUMMARY_USER_ID_MAX_LENGTH);
const HeadlineSchema = z.string().trim().min(1).max(CONCIERGE_ENRICHMENT_HEADLINE_MAX_LENGTH);
const SectionSchema = z.string().trim().min(1).max(CONCIERGE_ENRICHMENT_SECTION_MAX_LENGTH);
const NotesSchema = z.string().trim().min(1).max(CONCIERGE_ENRICHMENT_NOTES_MAX_LENGTH);
const TimestampSchema = z.string().datetime({ offset: true });

/**
 * A Monday-anchored `YYYY-MM-DD` week-start date. Validates the calendar date
 * is real (`2026-02-30` is rejected — the parsed `Date` must round-trip back to
 * the same string) AND falls on a Monday (`getUTCDay() === 1`), so the week key
 * is canonical.
 */
export const ConciergeEnrichmentWeekStartDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .superRefine((value, ctx) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a real calendar date' });
      return;
    }
    if (parsed.getUTCDay() !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be a Monday (the canonical week-start anchor)',
      });
    }
  });

// ─── Summary record ─────────────────────────────────────────────────────

/**
 * One weekly enrichment summary. The same shape is returned to both the admin
 * ops surfaces and the family read (the family only ever receives `published`
 * rows). `publishedAt` / `publishedByUserId` are set when the summary is
 * published; `archivedAt` when it is archived.
 */
export const ConciergeEnrichmentSummaryRecordSchema = z
  .object({
    id: IdSchema,
    householdId: HouseholdIdSchema,
    weekStartDate: ConciergeEnrichmentWeekStartDateSchema,
    status: ConciergeEnrichmentSummaryStatusSchema,
    headline: HeadlineSchema,
    visitHighlights: SectionSchema,
    wellnessSignals: SectionSchema,
    socialEngagement: SectionSchema,
    additionalNotes: NotesSchema.nullable(),
    authoredByUserId: UserIdSchema.nullable(),
    publishedAt: TimestampSchema.nullable(),
    publishedByUserId: UserIdSchema.nullable(),
    archivedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type ConciergeEnrichmentSummaryRecord = z.infer<
  typeof ConciergeEnrichmentSummaryRecordSchema
>;

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/concierge/enrichment-summaries` body — open a new weekly
 * summary as a `draft` (`householdId` required — the ops actor is
 * global-scoped). `weekStartDate` is the Monday the week begins. The three
 * narrative sections are required; `additionalNotes` is optional. A household
 * may have at most one non-deleted summary per week — a second create for the
 * same week is a 409.
 */
export const CreateConciergeEnrichmentSummaryRequestSchema = z
  .object({
    householdId: HouseholdIdSchema,
    weekStartDate: ConciergeEnrichmentWeekStartDateSchema,
    headline: HeadlineSchema,
    visitHighlights: SectionSchema,
    wellnessSignals: SectionSchema,
    socialEngagement: SectionSchema,
    additionalNotes: NotesSchema.optional(),
  })
  .strict();
export type CreateConciergeEnrichmentSummaryRequest = z.infer<
  typeof CreateConciergeEnrichmentSummaryRequestSchema
>;

/** `POST .../enrichment-summaries` response — the newly-created draft summary. */
export const CreateConciergeEnrichmentSummaryResponseSchema = z
  .object({
    summary: ConciergeEnrichmentSummaryRecordSchema,
  })
  .strict();
export type CreateConciergeEnrichmentSummaryResponse = z.infer<
  typeof CreateConciergeEnrichmentSummaryResponseSchema
>;

// ─── Update ─────────────────────────────────────────────────────────────

/**
 * `PATCH /api/v1/admin/concierge/enrichment-summaries/:summaryId` body — edit
 * the narrative fields and/or transition the status. At least one field must be
 * present. `additionalNotes` accepts `null` to clear. `status` drives the
 * lifecycle (`draft` / `published` / `archived`); setting it to the same value
 * is a no-op, and an unsupported transition is a 409. Publishing stamps
 * `publishedAt` + `publishedByUserId`; archiving stamps `archivedAt`.
 */
export const UpdateConciergeEnrichmentSummaryRequestSchema = z
  .object({
    headline: HeadlineSchema.optional(),
    visitHighlights: SectionSchema.optional(),
    wellnessSignals: SectionSchema.optional(),
    socialEngagement: SectionSchema.optional(),
    additionalNotes: NotesSchema.nullable().optional(),
    status: ConciergeEnrichmentSummaryStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one field must be supplied',
      });
    }
  });
export type UpdateConciergeEnrichmentSummaryRequest = z.infer<
  typeof UpdateConciergeEnrichmentSummaryRequestSchema
>;

/** `PATCH .../enrichment-summaries/:summaryId` response — the updated summary. */
export const UpdateConciergeEnrichmentSummaryResponseSchema = z
  .object({
    summary: ConciergeEnrichmentSummaryRecordSchema,
  })
  .strict();
export type UpdateConciergeEnrichmentSummaryResponse = z.infer<
  typeof UpdateConciergeEnrichmentSummaryResponseSchema
>;

// ─── Get (detail) ───────────────────────────────────────────────────────

/** `GET .../enrichment-summaries/:summaryId` response — the summary, or 404. */
export const GetConciergeEnrichmentSummaryResponseSchema = z
  .object({
    summary: ConciergeEnrichmentSummaryRecordSchema,
  })
  .strict();
export type GetConciergeEnrichmentSummaryResponse = z.infer<
  typeof GetConciergeEnrichmentSummaryResponseSchema
>;

// ─── List (admin) ───────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/concierge/enrichment-summaries` query. With no filters
 * returns summaries across every household, newest-week-first. `householdId`
 * narrows to one household; `status` narrows by lifecycle state.
 */
export const ListConciergeEnrichmentSummariesQuerySchema = z
  .object({
    householdId: HouseholdIdSchema.optional(),
    status: ConciergeEnrichmentSummaryStatusSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_MAX)
      .default(CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type ListConciergeEnrichmentSummariesQuery = z.infer<
  typeof ListConciergeEnrichmentSummariesQuerySchema
>;

/**
 * `GET /api/v1/admin/concierge/enrichment-summaries` response — the matching
 * summaries newest-week-first. Bounded by `limit`; no cursor at Phase-1 volume.
 */
export const ConciergeEnrichmentSummariesListResponseSchema = z
  .object({
    summaries: z.array(ConciergeEnrichmentSummaryRecordSchema),
  })
  .strict();
export type ConciergeEnrichmentSummariesListResponse = z.infer<
  typeof ConciergeEnrichmentSummariesListResponseSchema
>;

// ─── Family reads ───────────────────────────────────────────────────────

/**
 * `GET /api/v1/concierge/enrichment-summaries/me` query — bounded list cap for
 * the family dashboard read. Only PUBLISHED summaries are returned regardless
 * of any other state.
 */
export const MyConciergeEnrichmentSummariesQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_MAX)
      .default(CONCIERGE_ENRICHMENT_SUMMARIES_LIST_LIMIT_DEFAULT),
  })
  .strict();
export type MyConciergeEnrichmentSummariesQuery = z.infer<
  typeof MyConciergeEnrichmentSummariesQuerySchema
>;

/**
 * `GET /api/v1/concierge/enrichment-summaries/me` response — the household's
 * PUBLISHED summaries (newest-week-first), resolved from the token
 * `tenantScope`. No household id is supplied by the caller. `summaries: []`
 * when the household has none.
 */
export const MyConciergeEnrichmentSummariesResponseSchema = z
  .object({
    householdId: HouseholdIdSchema,
    summaries: z.array(ConciergeEnrichmentSummaryRecordSchema),
  })
  .strict();
export type MyConciergeEnrichmentSummariesResponse = z.infer<
  typeof MyConciergeEnrichmentSummariesResponseSchema
>;

/**
 * `GET /api/v1/concierge/enrichment-summaries/me/:summaryId` response — the
 * permalink target: one PUBLISHED summary scoped to the caller's household,
 * resolved from the token `tenantScope`. `summary: null` when the id does not
 * resolve to a published summary for this household (so a foreign / draft /
 * archived id is indistinguishable from a missing one — no oracle).
 */
export const MyConciergeEnrichmentSummaryResponseSchema = z
  .object({
    householdId: HouseholdIdSchema,
    summary: ConciergeEnrichmentSummaryRecordSchema.nullable(),
  })
  .strict();
export type MyConciergeEnrichmentSummaryResponse = z.infer<
  typeof MyConciergeEnrichmentSummaryResponseSchema
>;
