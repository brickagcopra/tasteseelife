import { z } from 'zod';

/**
 * Admin booking-hold read surface (TS-304-followup-3; PRD §10.14,
 * PDD §16.1; CLAUDE.md §12).
 *
 * Response and query shapes for `GET /api/v1/admin/booking-holds` —
 * "what is currently suspended, since when, by which incident, and how
 * much care is that interrupting".
 *
 * **Read-only, and that is the whole design.** TS-304 deliberately
 * shipped NO HTTP surface for placing or lifting a hold from the
 * booking side: a hold originates from a trust & safety incident and
 * is lifted by the committee closing that incident, so a write
 * endpoint here would be a way to un-suspend a provider without
 * touching the incident that suspended them. But there was also no way
 * to SEE what was suspended — `booking_subject_holds` was queryable
 * only in-process — which meant a committee deliberating on a hold had
 * no way to weigh what it was costing. This closes the read half and
 * leaves the write half deliberately absent.
 */

// ─────────────────────────────────────────────────────────────────────
// Bounds and enums
// ─────────────────────────────────────────────────────────────────────

export const BOOKING_HOLD_LIMIT_DEFAULT = 50;
export const BOOKING_HOLD_LIMIT_MAX = 200;
export const BOOKING_HOLD_OFFSET_MAX = 10_000;

/** Mirrors `booking.booking_subject_hold_kind`. Provider-first, as everywhere else. */
export const BookingHoldSubjectKindSchema = z.enum(['provider', 'senior', 'household']);
export type BookingHoldSubjectKind = z.infer<typeof BookingHoldSubjectKindSchema>;

/**
 * Which holds to list.
 *
 * `active` (the default) is the operational question — what is
 * suspended right now. `released` is the audit question — what was
 * suspended and is no longer. `all` exists so a subject's whole hold
 * history is reachable in one call when a committee is reviewing a
 * pattern rather than an incident.
 *
 * A hold row is never deleted and `releasedAt` is never cleared back to
 * null (a re-opened concern is a new incident with a new hold), so
 * these three sets partition cleanly and permanently.
 */
export const BookingHoldStatusFilterSchema = z.enum(['active', 'released', 'all']);
export type BookingHoldStatusFilter = z.infer<typeof BookingHoldStatusFilterSchema>;

// ─────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────

/**
 * One hold row — one (incident, subject) pair.
 *
 * An incident that names a provider, a senior, and a household produces
 * THREE rows, because each subject is held independently and each can
 * be the thing an operator is looking for.
 *
 * `severity` and `category` are SNAPSHOTS taken from the hold request
 * event, not live reads of the incident. They are typed as plain
 * strings rather than the trust-safety enums on purpose: this is
 * service-booking's copy of what trust & safety said at hold time, and
 * pinning it to the current enum would make a future severity value
 * break a read of an old row. The incident is one click away for the
 * live truth.
 *
 * `heldAt` is the incident's `openedAt` as carried on the event — the
 * moment the concern was raised, not the moment this service processed
 * it. Likewise `releasedAt` is the committee's resolution moment.
 */
export const BookingHoldRowSchema = z
  .object({
    id: z.string().min(1).max(64),
    incidentId: z.string().min(1).max(64),
    subjectKind: BookingHoldSubjectKindSchema,
    subjectId: z.string().min(1).max(64),
    severity: z.string().min(1).max(64),
    category: z.string().min(1).max(64),
    heldAt: z.string().datetime(),
    releasedAt: z.string().datetime().nullable(),
    /**
     * Bookings currently stamped as suspended by **this incident**.
     *
     * **Per-incident, not per-subject — and the name says so because
     * the distinction is easy to get wrong and expensive when you do.**
     * A suspended booking carries `held_by_incident_id`; it does not
     * record which of the incident's subjects caused the hold, because
     * one booking can involve two held subjects at once and there is no
     * single answer. So when an incident holds both a provider and a
     * household, both rows here carry the same number and it is the
     * same set of bookings. **Do not sum this column.** Inventing a
     * per-subject split would mean guessing, and a fabricated number on
     * a surface a committee deliberates from is worse than an honest
     * shared one.
     *
     * Zero is a real and common answer: a held provider with no
     * upcoming visits interrupts no care, which is exactly the fact the
     * committee wants.
     *
     * Always counts CURRENTLY-suspended bookings, so a released hold
     * normally reports 0 — the historical figure is not recoverable
     * from the booking row, which is cleared on release.
     */
    incidentSuspendedBookingCount: z.number().int().min(0),
  })
  .strict();
export type BookingHoldRow = z.infer<typeof BookingHoldRowSchema>;

// ─────────────────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/booking-holds` query.
 *
 * `subjectId` without `subjectKind` is REJECTED rather than matched
 * across kinds. The three id spaces are separate services' primary keys
 * and a bare id search would answer "is anything with this id held",
 * which is not a question anyone has — and would silently match a
 * household whose id happened to collide with the provider id being
 * looked up.
 */
export const ListBookingHoldsQuerySchema = z
  .object({
    status: BookingHoldStatusFilterSchema.default('active'),
    incidentId: z.string().min(1).max(64).optional(),
    subjectKind: BookingHoldSubjectKindSchema.optional(),
    subjectId: z.string().min(1).max(64).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(BOOKING_HOLD_LIMIT_MAX)
      .default(BOOKING_HOLD_LIMIT_DEFAULT),
    offset: z.coerce.number().int().min(0).max(BOOKING_HOLD_OFFSET_MAX).default(0),
  })
  .strict()
  .refine((value) => value.subjectId === undefined || value.subjectKind !== undefined, {
    message: 'subjectKind is required when subjectId is supplied.',
    path: ['subjectKind'],
  });
export type ListBookingHoldsQuery = z.infer<typeof ListBookingHoldsQuerySchema>;

// ─────────────────────────────────────────────────────────────────────
// Response
// ─────────────────────────────────────────────────────────────────────

/**
 * `GET /api/v1/admin/booking-holds` response.
 *
 * Ordered `heldAt` DESC, then `incidentId` ASC, then `subjectKind` ASC
 * — newest concern first, with an incident's several subject rows kept
 * adjacent and in the canonical provider → senior → household order, so
 * a reader can see at a glance that three rows are one incident rather
 * than three.
 *
 * `total` counts hold ROWS matching the filters, not incidents. A
 * console that says "3 holds" over three rows of one incident is
 * telling the truth about rows; it is the consumer's job to group by
 * incident on screen, which is also what makes the shared booking count
 * legible.
 */
export const BookingHoldListResponseSchema = z
  .object({
    holds: z.array(BookingHoldRowSchema),
    total: z.number().int().min(0),
    limit: z.number().int().positive(),
    offset: z.number().int().min(0),
  })
  .strict();
export type BookingHoldListResponse = z.infer<typeof BookingHoldListResponseSchema>;
