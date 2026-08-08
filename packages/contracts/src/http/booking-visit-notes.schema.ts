import { z } from 'zod';

import { BOOKING_ID_MAX_LENGTH } from './booking-commission.schema';

/**
 * Booking visit notes HTTP DTOs (TS-062; PRD §6.4 family peace-of-
 * mind dashboard, PRD §7.4 provider visit workflow, PDD §8.2 column
 * inventory, PDD §9.2 lifecycle sequence).
 *
 * The provider records a structured wellness observation note during
 * the visit workflow (in_progress → completed). The note is the
 * primary input to the family wellness summary email (PRD §6.9) and
 * to ops triage when a welfare concern is flagged.
 *
 * **Two halves to the payload.**
 *
 *   - **Structured wellness fields** — coarse-grained 5-point scales
 *     for `mood`, `appetite`, `hydration`, `socialEngagement`. Each
 *     is optional so a provider can submit an incomplete note while
 *     the visit is in progress and update it before check-out.
 *     Coarse-grained values are the explicit product choice:
 *     fine-grained numeric scoring would push the platform toward
 *     clinical language (CLAUDE.md §12 — "hospitality, not
 *     clinical").
 *
 *   - **Free-form + photos** — `freeform` is a 2000-char text field
 *     for the provider to add narrative context. `photoKeys` is an
 *     array of media-svc asset keys (the actual photos live in S3
 *     behind the signed-URL pipeline; this carries only the
 *     reference). Senior consent gates photo capture (CLAUDE.md
 *     §12); the contract layer does not enforce consent — the
 *     service surface checks consent before accepting a non-empty
 *     `photoKeys` array (Phase 2 — TS-033-followup-4 captures the
 *     analogous gate on memory-recipe images).
 *
 * **One row per booking.** The DB shape (`booking_visit_notes`) is
 * keyed by `bookingId` UNIQUE — every booking has at most one visit
 * notes row. Re-submitting via PUT upserts the row; the audit metadata
 * (`recordedAt`, `recordedByUserId`, `updatedAt`) tracks the lineage.
 *
 * **Lifecycle gate.** The service layer accepts upsert only when the
 * booking is `in_progress` or `completed` (PDD §9.2 — provider submits
 * notes around check-out). Earlier or later states surface as a
 * `forbidden` failure at the service boundary.
 *
 * **`.strict()` everywhere** — unknown fields are a parse error so a
 * typo or a stray client field never silently round-trips
 * (CLAUDE.md §3.3).
 */

/**
 * Mood — coarse-grained 5-point ordinal scale. Always optional so a
 * provider can leave the field blank when they can't read the
 * senior's affect (e.g. a brief drop-off visit).
 *
 *   - `low`           — withdrawn, sad, anxious
 *   - `subdued`       — quiet, tired, flat
 *   - `neutral`       — present, calm, engaged at baseline
 *   - `bright`        — cheerful, conversational, attentive
 *   - `joyful`        — animated, laughing, deeply engaged
 */
export const VisitNoteMoodSchema = z.enum(['low', 'subdued', 'neutral', 'bright', 'joyful']);
export type VisitNoteMood = z.infer<typeof VisitNoteMoodSchema>;

/**
 * Appetite — coarse-grained 5-point ordinal scale. Optional. Drives
 * the wellness-summary email (PRD §6.9) and the trust-safety welfare
 * signal when persistently `none` or `minimal` (PDD §16.1).
 *
 *   - `none`     — refused the meal
 *   - `minimal`  — a few bites
 *   - `moderate` — finished about half the plate
 *   - `hearty`   — finished the plate
 *   - `robust`   — finished the plate plus seconds
 */
export const VisitNoteAppetiteSchema = z.enum(['none', 'minimal', 'moderate', 'hearty', 'robust']);
export type VisitNoteAppetite = z.infer<typeof VisitNoteAppetiteSchema>;

/**
 * Hydration — coarse-grained 5-point ordinal scale. Optional. The
 * provider records the senior's water / beverage intake during the
 * visit. Persistently `poor` flags a welfare signal (PDD §16.1).
 *
 *   - `poor`     — refused fluids
 *   - `light`    — a few sips
 *   - `adequate` — finished one glass / cup
 *   - `good`     — finished multiple glasses / cups
 *   - `excellent` — abundantly hydrated
 */
export const VisitNoteHydrationSchema = z.enum(['poor', 'light', 'adequate', 'good', 'excellent']);
export type VisitNoteHydration = z.infer<typeof VisitNoteHydrationSchema>;

/**
 * Social engagement — coarse-grained 5-point ordinal scale. Optional.
 * Captures how much the senior interacted with the provider during
 * the visit. The PRD §6.4 family peace-of-mind dashboard surfaces
 * this so adult children see "how engaged was mom today" without
 * reading freeform prose.
 *
 *   - `withdrawn`   — minimal interaction, head-down, monosyllabic
 *   - `reserved`    — polite, brief exchanges
 *   - `present`     — conversational at baseline
 *   - `engaged`     — actively curious, asked questions
 *   - `vibrant`     — animated, storytelling, deeply connected
 */
export const VisitNoteSocialEngagementSchema = z.enum([
  'withdrawn',
  'reserved',
  'present',
  'engaged',
  'vibrant',
]);
export type VisitNoteSocialEngagement = z.infer<typeof VisitNoteSocialEngagementSchema>;

/**
 * Freeform text length cap. 2000 chars matches the senior-intake
 * `medicalNotes` ceiling — long enough for meaningful narrative,
 * short enough that an attacker can't use the field as a bulk-exfil
 * bucket (CLAUDE.md §3.9 PII discipline).
 */
export const VISIT_NOTES_FREEFORM_MAX_LENGTH = 2_000;

/**
 * Per-row photo key cap. The provider attaches at most this many
 * photos to a single visit notes row. The actual photo assets live
 * in media-svc behind the signed-URL pipeline (CLAUDE.md §3.4); this
 * cap bounds the JSON payload size and the family-portal render
 * footprint.
 */
export const VISIT_NOTES_PHOTO_KEYS_MAX = 12;

/**
 * Media-svc asset key length cap. CUID-style keys land at ~32 chars;
 * 128 leaves headroom for any future key shape without removing the
 * defence against unbounded strings.
 */
export const VISIT_NOTES_PHOTO_KEY_MAX_LENGTH = 128;

/**
 * Photo key schema — opaque media-svc asset key (the signed-URL
 * pipeline assigns these). Pattern enforces "non-empty + bounded".
 * Senior-consent gating is enforced at the service layer, not here.
 */
const PhotoKeySchema = z
  .string()
  .min(1)
  .max(VISIT_NOTES_PHOTO_KEY_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._-]+$/, 'photo key must be alphanumeric + . _ -');

/**
 * Booking id schema — bounded so a stray-string field can't blow the
 * downstream payload. Reuses the constant from booking-commission
 * (the soft-FK length floor is the same across the booking domain).
 */
const BookingIdSchema = z.string().min(1).max(BOOKING_ID_MAX_LENGTH);

/**
 * `PUT /api/v1/bookings/:id/visit-notes` request body.
 *
 * Every field optional so a partial save lands a valid row. A fully
 * empty payload (`{}`) is rejected by `.superRefine` so the provider
 * doesn't accidentally clear the row by submitting an empty form —
 * an explicit `DELETE` surface (out of scope for TS-062; deferred
 * to a follow-up) is the correct affordance for a hard reset.
 *
 * `recordedByUserId` is NOT on the wire — the service stamps it
 * from the authenticated request context (CLAUDE.md §3.2 — actor
 * is never client-supplied).
 */
export const UpsertVisitNotesRequestSchema = z
  .object({
    mood: VisitNoteMoodSchema.nullable().optional(),
    appetite: VisitNoteAppetiteSchema.nullable().optional(),
    hydration: VisitNoteHydrationSchema.nullable().optional(),
    socialEngagement: VisitNoteSocialEngagementSchema.nullable().optional(),
    freeform: z.string().max(VISIT_NOTES_FREEFORM_MAX_LENGTH).nullable().optional(),
    photoKeys: z
      .array(PhotoKeySchema)
      .max(VISIT_NOTES_PHOTO_KEYS_MAX, `at most ${VISIT_NOTES_PHOTO_KEYS_MAX} photo keys`)
      .optional()
      .default([]),
  })
  .strict()
  .superRefine((body, ctx) => {
    // A fully empty payload is a no-op — reject so the provider gets
    // an actionable 400 rather than a silent no-write. `photoKeys`
    // defaults to []; we treat "all null + empty array" as empty.
    const hasAny =
      body.mood !== undefined && body.mood !== null
        ? true
        : body.appetite !== undefined && body.appetite !== null
          ? true
          : body.hydration !== undefined && body.hydration !== null
            ? true
            : body.socialEngagement !== undefined && body.socialEngagement !== null
              ? true
              : body.freeform !== undefined && body.freeform !== null && body.freeform.length > 0
                ? true
                : body.photoKeys.length > 0;
    if (!hasAny) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'visit notes payload must include at least one observation field',
        path: [],
      });
    }
  });
export type UpsertVisitNotesRequest = z.infer<typeof UpsertVisitNotesRequestSchema>;

/**
 * `GET /api/v1/bookings/:id/visit-notes` response and
 * `PUT /api/v1/bookings/:id/visit-notes` 200/201 response.
 *
 * Returns the persisted observation fields plus three audit fields:
 *
 *   - `bookingId` — echoed for clients that fan out multiple booking
 *     fetches and key by id.
 *   - `recordedByUserId` — the actor on the most recent write.
 *   - `recordedAt` — the wall-clock time of the most recent write.
 *     Stays distinct from `updatedAt` because the row's `updatedAt`
 *     also moves on an internal touch (e.g. a future moderation
 *     workflow rewriting the freeform field for PII redaction).
 *
 * On GET, an empty row (the booking has no visit notes yet) surfaces
 * as a 404 — the family-portal renders an empty-state placeholder.
 */
export const VisitNotesResponseSchema = z
  .object({
    bookingId: BookingIdSchema,
    mood: VisitNoteMoodSchema.nullable(),
    appetite: VisitNoteAppetiteSchema.nullable(),
    hydration: VisitNoteHydrationSchema.nullable(),
    socialEngagement: VisitNoteSocialEngagementSchema.nullable(),
    freeform: z.string().nullable(),
    photoKeys: z.array(z.string()),
    recordedByUserId: z.string().min(1),
    recordedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type VisitNotesResponse = z.infer<typeof VisitNotesResponseSchema>;
