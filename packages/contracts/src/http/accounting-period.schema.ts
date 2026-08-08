import { z } from 'zod';

import { JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH } from './journal.schema';

/**
 * Accounting period close + reopen + calendar contracts (TS-085, PDD
 * §11.2, CLAUDE.md §6).
 *
 * Five admin write/read surfaces:
 *
 *   - `GET /api/v1/admin/periods` — list periods (status filter +
 *     calendar-ordered).
 *   - `GET /api/v1/admin/periods/:periodName` — fetch one period by
 *     name.
 *   - `POST /api/v1/admin/periods/generate` — calendar generator. Ahead-
 *     of-time creation of monthly periods covering an inclusive
 *     `[startYearMonth, endYearMonth]` range; idempotent against
 *     existing rows (already-present names are reported in `existed`,
 *     not re-inserted).
 *   - `POST /api/v1/admin/periods/:periodName/close` — flip status
 *     `open → closed`; stamps `closedAt` + `closedByUserId`; appends a
 *     `period_lifecycle_events` audit row.
 *   - `POST /api/v1/admin/periods/:periodName/reopen` — flip status
 *     `closed → open`; preserves the prior `closedAt` + `closedByUserId`
 *     (the close is the audit record); appends an audit row of kind
 *     `reopen` with the actor + reason code.
 *
 * **Idempotency.** Each lifecycle write carries a `sourceEventId` that
 * the service stores on the audit row with a UNIQUE constraint. A
 * redelivered request (admin double-click, network retry) returns the
 * cached lifecycle response unchanged — the second line of defence on
 * top of the `@Idempotent()` Idempotency-Key cache.
 *
 * **Role gating.** `finance:adjust` is the role the close/reopen
 * endpoints require (CLAUDE.md §6). Permission-string gating lands once
 * the shared `packages/nest-auth` package arrives (TS-052-followup-11);
 * until then the controller's `AccessTokenGuard` requires authentication
 * and the audit row records the actor for review.
 */

/**
 * Period lifecycle status. Mirrors `accounting.period_status` 1:1.
 *
 * - `open`   — TS-081 accepts posts whose `occurred_at` falls inside
 *              `[startDate, endDate]`.
 * - `closed` — Posts require `finance:adjust` AND an explicit reopen.
 */
export const PeriodStatusSchema = z.enum(['open', 'closed']);
export type PeriodStatus = z.infer<typeof PeriodStatusSchema>;

/**
 * Lifecycle event kind. Captures every `open → closed` and
 * `closed → open` transition so the per-period audit trail is the
 * canonical record (the `AccountingPeriod.closedAt` column is the
 * MOST RECENT close only — a re-close overwrites; the events table
 * preserves every transition).
 */
export const PeriodLifecycleEventKindSchema = z.enum(['close', 'reopen']);
export type PeriodLifecycleEventKind = z.infer<typeof PeriodLifecycleEventKindSchema>;

/**
 * Canonical `YYYY-MM` period-name regex. Phase-1 monthly cadence; a
 * future quarterly / fiscal cadence is a separate contract (and a
 * separate calendar generator).
 *
 * Captures `2026-01` through `2099-12`. The year is unconstrained
 * beyond four digits at the regex layer — out-of-range years (the
 * accounting books are not expected to span centuries) are rejected
 * at the service layer rather than the contract, so a Phase-2 expand
 * of the historical-data ingest can backfill periods without
 * contract churn.
 */
export const PERIOD_NAME_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PERIOD_NAME_MAX_LENGTH = 64;

/**
 * Period name shape (`YYYY-MM`). The service ALSO accepts quarterly /
 * custom-fiscal names long-term, but the calendar generator + listing
 * endpoints exposed today are all monthly; the schema pins the shape
 * accordingly.
 */
export const PeriodNameSchema = z
  .string()
  .regex(PERIOD_NAME_REGEX, 'period name must be YYYY-MM (e.g. "2026-05")')
  .max(PERIOD_NAME_MAX_LENGTH);
export type PeriodName = z.infer<typeof PeriodNameSchema>;

/**
 * Maximum length of an admin-supplied reason code on close / reopen
 * (CLAUDE.md §6: every period-lifecycle change is audit-logged with
 * a reason). Mirrors `JOURNAL_REVERSAL_REASON_MAX_LENGTH` so audit
 * grep across journals + period events is uniform.
 */
export const PERIOD_LIFECYCLE_REASON_MAX_LENGTH = 500;
/**
 * Cap on the free-text description carried on a close / reopen
 * request. Surfaces in finance reports + the admin audit browser.
 */
export const PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH = 1_000;

/**
 * Inclusive bound on the calendar generator request — Phase-1 ops
 * generally generate one fiscal year of periods (12 months) ahead;
 * a single generate call producing more than the cap is rejected
 * to defend against a runaway admin script. The cap is admin-
 * configurable behind a follow-up if ops legitimately need to
 * backfill multiple decades.
 */
export const GENERATE_PERIODS_MAX_COUNT = 60;

/**
 * Period DTO. Wire-shape mirrors the Prisma row with two adjustments:
 *
 *   - `startDate` / `endDate` are ISO-8601 date strings (`YYYY-MM-DD`).
 *     The Prisma column is `@db.Date` — no time component is meaningful.
 *   - `closedAt` is an ISO-8601 datetime (carries the close moment to
 *     the second); preserved across reopens.
 *
 * `.strict()` rejects unknown fields at parse time.
 */
export const PeriodResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: PeriodNameSchema,
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD'),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be YYYY-MM-DD'),
    status: PeriodStatusSchema,
    closedAt: z.string().datetime().nullable(),
    closedByUserId: z.string().min(1).max(64).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type PeriodResponse = z.infer<typeof PeriodResponseSchema>;

/**
 * `GET /api/v1/admin/periods` query parameters.
 *
 * - `status` — optional filter; absent ⇒ both statuses returned.
 * - `limit`  — 1..100, default 50. Capped to bound the response size.
 * - `cursor` — opaque cursor token used for pagination. The cursor is
 *   the `start_date` of the last period on the previous page (encoded
 *   server-side). Forward-compatible with the standard cursor pattern.
 */
export const LIST_PERIODS_LIMIT_DEFAULT = 50;
export const LIST_PERIODS_LIMIT_MAX = 100;
export const ListPeriodsQuerySchema = z
  .object({
    status: PeriodStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(LIST_PERIODS_LIMIT_MAX).optional(),
    cursor: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ListPeriodsQuery = z.infer<typeof ListPeriodsQuerySchema>;

/**
 * `GET /api/v1/admin/periods` response. Wrapped in `{ periods: [...] }`
 * + `nextCursor` so future summary fields (total count, MRR roll-up by
 * period, etc.) land additively without breaking v1.
 */
export const PeriodsListResponseSchema = z
  .object({
    periods: z.array(PeriodResponseSchema),
    nextCursor: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type PeriodsListResponse = z.infer<typeof PeriodsListResponseSchema>;

/**
 * `POST /api/v1/admin/periods/:periodName/close` request body.
 *
 * - `sourceEventId` — admin-generated stable id for the close
 *   action; the audit row's UNIQUE constraint replays the response
 *   on a redelivery without writing a duplicate audit event.
 * - `occurredAt` — when the close decision was effective. Defaults
 *   to the service's `now()` when omitted.
 * - `reasonCode` — required; finance audit needs a reason for every
 *   close. Free-form text (capped). The same vocabulary as
 *   `manual-adjustment.reasonCode` so finance trails are uniform.
 * - `description` — optional longer-form context.
 */
export const ClosePeriodRequestSchema = z
  .object({
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    occurredAt: z.string().datetime().optional(),
    reasonCode: z.string().min(1).max(PERIOD_LIFECYCLE_REASON_MAX_LENGTH),
    description: z.string().min(1).max(PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();
export type ClosePeriodRequest = z.infer<typeof ClosePeriodRequestSchema>;

/**
 * `POST /api/v1/admin/periods/:periodName/reopen` request body.
 *
 * Same shape as `ClosePeriodRequest`. The two are NOT consolidated into
 * one schema with an `action` field because the URL path already
 * communicates the action; the symmetric shape is incidental.
 */
export const ReopenPeriodRequestSchema = z
  .object({
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    occurredAt: z.string().datetime().optional(),
    reasonCode: z.string().min(1).max(PERIOD_LIFECYCLE_REASON_MAX_LENGTH),
    description: z.string().min(1).max(PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH).optional(),
  })
  .strict();
export type ReopenPeriodRequest = z.infer<typeof ReopenPeriodRequestSchema>;

/**
 * Lifecycle event DTO. Surfaces on the response of close / reopen so
 * the caller can render the audit row without re-fetching.
 */
export const PeriodLifecycleEventResponseSchema = z
  .object({
    id: z.string().min(1).max(64),
    periodId: z.string().min(1).max(64),
    periodName: PeriodNameSchema,
    kind: PeriodLifecycleEventKindSchema,
    actorUserId: z.string().min(1).max(64),
    sourceEventId: z.string().min(1).max(JOURNAL_SOURCE_EVENT_ID_MAX_LENGTH),
    reasonCode: z.string().min(1).max(PERIOD_LIFECYCLE_REASON_MAX_LENGTH),
    description: z.string().min(1).max(PERIOD_LIFECYCLE_DESCRIPTION_MAX_LENGTH).nullable(),
    occurredAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PeriodLifecycleEventResponse = z.infer<typeof PeriodLifecycleEventResponseSchema>;

/**
 * Response for `POST /api/v1/admin/periods/:periodName/close` and
 * `/reopen`. Returns the resulting period state + the audit event +
 * the `result` discriminator (`{closed,reopened,idempotent_replay}`).
 *
 * The discriminator lets the caller distinguish "I actually transitioned
 * the period" from "this is the cached response of a prior call",
 * without parsing timestamps.
 */
export const PeriodLifecycleResponseSchema = z
  .object({
    period: PeriodResponseSchema,
    event: PeriodLifecycleEventResponseSchema,
    result: z.enum(['closed', 'reopened', 'idempotent_replay']),
  })
  .strict();
export type PeriodLifecycleResponse = z.infer<typeof PeriodLifecycleResponseSchema>;

/**
 * `POST /api/v1/admin/periods/generate` request body.
 *
 * `startYearMonth` / `endYearMonth` are inclusive `YYYY-MM` names; the
 * service computes the monthly calendar covering the range and
 * inserts every name that doesn't already exist.
 *
 * Idempotency is intrinsic — re-running with the same range is a
 * no-op (every requested name now exists). The `@Idempotent()` cache
 * layer in the controller still de-duplicates retries within the
 * cache window so the consumer never sees a partial result on a
 * network glitch.
 */
export const GeneratePeriodsRequestSchema = z
  .object({
    startYearMonth: PeriodNameSchema,
    endYearMonth: PeriodNameSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (compareYearMonth(body.startYearMonth, body.endYearMonth) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'startYearMonth must be ≤ endYearMonth',
        path: ['endYearMonth'],
      });
    }
  });
export type GeneratePeriodsRequest = z.infer<typeof GeneratePeriodsRequestSchema>;

/**
 * Response shape for the calendar generator.
 *
 * Surfaces the full list of created + pre-existing period rows so the
 * caller can render the resulting calendar without a follow-up GET.
 */
export const GeneratePeriodsResponseSchema = z
  .object({
    startYearMonth: PeriodNameSchema,
    endYearMonth: PeriodNameSchema,
    requestedCount: z.number().int().min(1).max(GENERATE_PERIODS_MAX_COUNT),
    createdCount: z.number().int().min(0).max(GENERATE_PERIODS_MAX_COUNT),
    existedCount: z.number().int().min(0).max(GENERATE_PERIODS_MAX_COUNT),
    created: z.array(PeriodResponseSchema),
    existed: z.array(PeriodResponseSchema),
  })
  .strict();
export type GeneratePeriodsResponse = z.infer<typeof GeneratePeriodsResponseSchema>;

/**
 * Compare two YYYY-MM strings lexicographically (which matches
 * chronological order because the format is zero-padded). Returns:
 *   - negative if `a < b`
 *   - 0 if equal
 *   - positive if `a > b`
 */
function compareYearMonth(a: string, b: string): number {
  return a.localeCompare(b);
}
