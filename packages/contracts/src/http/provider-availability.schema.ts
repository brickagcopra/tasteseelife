import { z } from 'zod';

/**
 * Provider availability contracts (TS-203).
 *
 * The self-service editor surface (`GET /api/v1/providers/me/availability-
 * snapshot`, `PUT /api/v1/providers/:providerId/availability`, `DELETE
 * /api/v1/providers/:providerId/availability`) plus the per-provider
 * record shape consumed by:
 *   - the web-provider availability page editor (TS-203)
 *   - the discovery-snapshot projection (TS-053 / TS-111 — search-indexer
 *     resolves the next-7-days window summary off this data)
 *   - the booking-svc availability gate (TS-060 / TS-205 — pre-flight
 *     check at booking-create time)
 *
 * **Data shape rationale** (PRD §7.3; PDD §8.2).
 *
 * Two storage axes:
 *
 *   1. Recurring weekly windows. One row per `(provider, weekday, start,
 *      end)` triple. A provider declares "Monday 09:00–13:00, Thursday
 *      18:00–21:00" with two rows. Multiple windows per weekday are
 *      allowed (e.g. lunch + dinner shifts) provided they do not overlap.
 *      Time-of-day is stored in the provider's `time_zone` (carried on
 *      the `providers` row, TS-050); the contract does NOT redundantly
 *      carry it on each window — clients combine `record.timeZone` with
 *      the window times when rendering.
 *
 *   2. Date-keyed exclusions. One row per `(provider, exception_date)`
 *      pair. A provider blocks "Sunday 2026-05-25" with a single row
 *      that disables ALL of that day's recurring windows. Partial-day
 *      blocks are not modelled in this phase — the simplest data shape
 *      that satisfies the PRD §7.3 "one-off exclusions" requirement
 *      without over-engineering.
 *
 * **No availability override at the date level** in this phase. The
 * follow-up TS-203-followup-1 lands a third row type: per-date
 * overrides ("normally I'm closed Sundays but on 2026-12-25 I'm open
 * 18:00–22:00 only"). The current shape supports the 80% case
 * (recurring + blackouts); the override layer ships when the family-
 * portal usage justifies the complexity budget.
 *
 * **Strict everywhere** — `.strict()` on every schema rejects unknown
 * fields at the boundary (CLAUDE.md §3.3). Window count + exception
 * count are bounded so a malformed admin write cannot OOM the
 * downstream.
 */

// ─── Bounded length / range constants ───────────────────────────────────

/** Soft FK length cap (providerId). Matches every other provider-domain id cap. */
export const PROVIDER_AVAILABILITY_ID_MAX_LENGTH = 64;

/** IANA time-zone string cap. Matches PROVIDER_DISCOVERY_TIME_ZONE_MAX_LENGTH. */
export const PROVIDER_AVAILABILITY_TIME_ZONE_MAX_LENGTH = 64;

/**
 * Cap on recurring weekly windows per provider. Seven weekdays × four
 * shifts per day (breakfast / lunch / dinner / late-night) generously
 * covers every realistic schedule a chef would declare. A 28-cap also
 * keeps the discovery-doc projection bounded — the next-7-days
 * resolved-window array sees at most 28 entries.
 */
export const PROVIDER_AVAILABILITY_WINDOWS_MAX = 28;

/**
 * Cap on date-keyed exclusions per request. 90 entries covers a full
 * quarter of one-off blackouts in advance (vacations, conferences,
 * personal events); beyond that, the provider should adjust their
 * recurring schedule rather than enumerate exclusions. The DB does
 * not enforce this cap — admin tooling can write more — but the
 * self-service surface stops here.
 */
export const PROVIDER_AVAILABILITY_EXCEPTIONS_MAX = 90;

/**
 * Cap on resolved next-7-days summary entries the discovery doc
 * (TS-111) carries. Seven days × four shifts per day = 28; matches
 * `PROVIDER_AVAILABILITY_WINDOWS_MAX`.
 */
export const PROVIDER_AVAILABILITY_SUMMARY_ENTRIES_MAX = 28;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(PROVIDER_AVAILABILITY_ID_MAX_LENGTH);
const TimeZoneSchema = z.string().min(1).max(PROVIDER_AVAILABILITY_TIME_ZONE_MAX_LENGTH);

/**
 * HH:MM 24-hour clock time-of-day. Stored DB-side as `time(0)` (no
 * sub-minute resolution). The regex rejects 24:00 (must be < 24:00)
 * and any non-zero-padded values; the same shape parses in every
 * timezone we serve (IANA zones use 24-hour wall-clock).
 *
 * Half-hour granularity is not enforced at the contract layer —
 * "09:15–13:30" is a valid window. Booking-svc availability scoring
 * (TS-060) treats availability as a closed range so sub-minute
 * fragments inside the range are usable.
 */
export const PROVIDER_AVAILABILITY_TIME_REGEX = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
export const ProviderAvailabilityTimeSchema = z
  .string()
  .regex(
    PROVIDER_AVAILABILITY_TIME_REGEX,
    "time must be HH:MM in the provider's local timezone (zero-padded, 24-hour)",
  );
export type ProviderAvailabilityTime = z.infer<typeof ProviderAvailabilityTimeSchema>;

/**
 * Calendar date YYYY-MM-DD in the provider's local timezone. Stored
 * DB-side as `date`. The regex rejects ill-shaped strings; the
 * downstream service additionally validates that the date is not in
 * the past at write time (a future-only exclusion makes operational
 * sense — a provider blocking yesterday is meaningless).
 */
export const PROVIDER_AVAILABILITY_DATE_REGEX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const ProviderAvailabilityDateSchema = z
  .string()
  .regex(
    PROVIDER_AVAILABILITY_DATE_REGEX,
    "date must be YYYY-MM-DD in the provider's local timezone",
  );
export type ProviderAvailabilityDate = z.infer<typeof ProviderAvailabilityDateSchema>;

/**
 * Weekday literal. Mirrors the Prisma `ProviderAvailabilityWeekday`
 * enum (TS-203 migration). Lowercased English names — the family-
 * portal's locale-aware rendering happens at the UI layer, not the
 * contract layer (the booking-svc availability gate matches on the
 * literal, so swapping to a numeric `0..6` here would force the
 * downstream to translate; the literal is the cheaper invariant).
 */
export const PROVIDER_AVAILABILITY_WEEKDAY_VALUES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;
export const ProviderAvailabilityWeekdaySchema = z.enum(PROVIDER_AVAILABILITY_WEEKDAY_VALUES);
export type ProviderAvailabilityWeekday = z.infer<typeof ProviderAvailabilityWeekdaySchema>;

// ─── Window + exception shapes ──────────────────────────────────────────

/**
 * A single recurring weekly window. `startTime` must be strictly less
 * than `endTime` (an inclusive-start, exclusive-end half-open
 * interval). Midnight-spanning windows are NOT supported — a chef who
 * wants Saturday 22:00 → Sunday 02:00 declares two windows:
 * `saturday 22:00–23:59` + `sunday 00:00–02:00`. This keeps the
 * booking-svc availability gate's day-keyed lookup simple and
 * matches how providers think about scheduling in practice.
 */
export const ProviderAvailabilityWindowSchema = z
  .object({
    weekday: ProviderAvailabilityWeekdaySchema,
    startTime: ProviderAvailabilityTimeSchema,
    endTime: ProviderAvailabilityTimeSchema,
  })
  .strict()
  .superRefine((window, ctx) => {
    if (window.startTime >= window.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endTime'],
        message: 'endTime must be strictly after startTime',
      });
    }
  });
export type ProviderAvailabilityWindow = z.infer<typeof ProviderAvailabilityWindowSchema>;

/**
 * A single date-keyed exclusion. The provider declares "I'm not
 * available on this date" with one row; the downstream booking-svc
 * availability gate treats every recurring window on that date as
 * blocked.
 */
export const ProviderAvailabilityExceptionSchema = z
  .object({
    date: ProviderAvailabilityDateSchema,
  })
  .strict();
export type ProviderAvailabilityException = z.infer<typeof ProviderAvailabilityExceptionSchema>;

// ─── Cross-window refinement (overlap detection per weekday) ────────────

/**
 * Reject two windows on the same weekday whose `[startTime, endTime)`
 * intervals overlap. The DB level relies on a `(provider_id, weekday,
 * start_time)` unique index to dedup exact starts; this refinement
 * catches the more general overlap case at the boundary (a Sunday
 * 09:00–13:00 row vs. a Sunday 12:00–14:00 row would slip past the
 * DB index but is semantic nonsense).
 */
function refineNoWindowOverlaps(
  windows: readonly ProviderAvailabilityWindow[],
  ctx: z.RefinementCtx,
): void {
  const byWeekday = new Map<ProviderAvailabilityWeekday, ProviderAvailabilityWindow[]>();
  for (const window of windows) {
    const bucket = byWeekday.get(window.weekday) ?? [];
    bucket.push(window);
    byWeekday.set(window.weekday, bucket);
  }
  for (const [weekday, bucket] of byWeekday) {
    bucket.sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < bucket.length; i++) {
      const prev = bucket[i - 1];
      const curr = bucket[i];
      if (prev === undefined || curr === undefined) continue;
      if (curr.startTime < prev.endTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['windows'],
          message: `overlapping windows on ${weekday}: ${prev.startTime}–${prev.endTime} and ${curr.startTime}–${curr.endTime}`,
        });
        return;
      }
    }
  }
}

function refineUniqueExceptionDates(
  exceptions: readonly ProviderAvailabilityException[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const exception of exceptions) {
    if (seen.has(exception.date)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exceptions'],
        message: `duplicate exception date: ${exception.date}`,
      });
      return;
    }
    seen.add(exception.date);
  }
}

// ─── Resolved next-7-days summary (TS-053 discovery-doc projection) ─────

/**
 * One resolved entry on the next-7-days summary. The discovery-doc
 * indexer projects this from the source-of-truth windows + exclusions
 * starting at the current date (in the provider's local timezone).
 * Booked-time gaps are NOT applied — the indexer doesn't see active
 * bookings; the family-portal search treats availability as a "could
 * be free" signal, not a "definitely free" guarantee. The booking-
 * svc availability gate is the authoritative final check at booking-
 * create time.
 */
export const ProviderAvailabilitySummaryEntrySchema = z
  .object({
    date: ProviderAvailabilityDateSchema,
    weekday: ProviderAvailabilityWeekdaySchema,
    startTime: ProviderAvailabilityTimeSchema,
    endTime: ProviderAvailabilityTimeSchema,
  })
  .strict();
export type ProviderAvailabilitySummaryEntry = z.infer<
  typeof ProviderAvailabilitySummaryEntrySchema
>;

export const ProviderAvailabilitySummarySchema = z
  .object({
    timeZone: TimeZoneSchema,
    entries: z
      .array(ProviderAvailabilitySummaryEntrySchema)
      .max(PROVIDER_AVAILABILITY_SUMMARY_ENTRIES_MAX),
    generatedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProviderAvailabilitySummary = z.infer<typeof ProviderAvailabilitySummarySchema>;

// ─── Snapshot / record (response shape) ─────────────────────────────────

/**
 * The materialised availability shape for one provider. Returned by
 * the snapshot GET + the PUT response. `windows` + `exceptions` are
 * the source-of-truth rows; `updatedAt` is the most-recent write to
 * either table (the service computes the max).
 */
export const ProviderAvailabilityRecordSchema = z
  .object({
    providerId: IdSchema,
    timeZone: TimeZoneSchema,
    windows: z.array(ProviderAvailabilityWindowSchema).max(PROVIDER_AVAILABILITY_WINDOWS_MAX),
    exceptions: z
      .array(ProviderAvailabilityExceptionSchema)
      .max(PROVIDER_AVAILABILITY_EXCEPTIONS_MAX),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderAvailabilityRecord = z.infer<typeof ProviderAvailabilityRecordSchema>;

/**
 * Snapshot response shape — `{ availability: null }` when the provider
 * has not yet declared any windows; `{ availability: ... }` once the
 * provider has saved at least one window or exclusion. The null
 * branch lets the editor render an empty-state placeholder without a
 * 404 round-trip.
 */
export const ProviderAvailabilitySnapshotResponseSchema = z
  .object({
    availability: ProviderAvailabilityRecordSchema.nullable(),
  })
  .strict();
export type ProviderAvailabilitySnapshotResponse = z.infer<
  typeof ProviderAvailabilitySnapshotResponseSchema
>;

// ─── Request shapes ─────────────────────────────────────────────────────

/**
 * Request body for `PUT /api/v1/providers/:providerId/availability`.
 *
 * Update semantics:
 *   - `windows` + `exceptions` are full-set replacements. The server
 *     runs `DELETE` + bulk-`INSERT` inside one transaction; consumers
 *     see the resulting set atomically. Submitting empty arrays clears
 *     the provider's availability (equivalent to a DELETE on the
 *     resource, though the DELETE endpoint is the more idiomatic
 *     gesture).
 *   - Cross-window overlap rejection runs at the boundary — a
 *     malformed PUT returns 400 before any DB hit.
 *   - Duplicate exception dates are rejected at the boundary.
 *
 * Notes deliberately NOT carried here:
 *   - `timeZone` — the field lives on the `providers` row (`providers.
 *     time_zone`). Editing it is a sibling TS-200-followup-3 surface;
 *     the availability editor reads but does not write it.
 *   - `providerId` — taken from the path param. Putting it in the body
 *     would create a path/body mismatch ambiguity (the service would
 *     have to pick one as authoritative).
 */
export const UpdateProviderAvailabilityRequestSchema = z
  .object({
    windows: z
      .array(ProviderAvailabilityWindowSchema)
      .max(PROVIDER_AVAILABILITY_WINDOWS_MAX)
      .superRefine(refineNoWindowOverlaps),
    exceptions: z
      .array(ProviderAvailabilityExceptionSchema)
      .max(PROVIDER_AVAILABILITY_EXCEPTIONS_MAX)
      .superRefine(refineUniqueExceptionDates),
  })
  .strict();
export type UpdateProviderAvailabilityRequest = z.infer<
  typeof UpdateProviderAvailabilityRequestSchema
>;

/**
 * Response body for `PUT /api/v1/providers/:providerId/availability`.
 * Wraps the materialised record so the shape is forward-compatible
 * with future side-payloads (e.g. a derived discovery-doc snapshot
 * for client-side cache pre-warm) without a v1 break.
 */
export const UpdateProviderAvailabilityResponseSchema = z
  .object({
    availability: ProviderAvailabilityRecordSchema,
  })
  .strict();
export type UpdateProviderAvailabilityResponse = z.infer<
  typeof UpdateProviderAvailabilityResponseSchema
>;

/**
 * Response body for `DELETE /api/v1/providers/:providerId/availability`.
 * Always returns 200 — a delete on an already-empty schedule is a no-
 * op success. `deletedWindowCount` + `deletedExceptionCount` carry
 * the count of rows actually removed so the editor can surface a
 * "no schedule was saved" hint when the user clicks delete on an
 * empty schedule.
 */
export const DeleteProviderAvailabilityResponseSchema = z
  .object({
    providerId: IdSchema,
    deletedWindowCount: z.number().int().nonnegative(),
    deletedExceptionCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteProviderAvailabilityResponse = z.infer<
  typeof DeleteProviderAvailabilityResponseSchema
>;
