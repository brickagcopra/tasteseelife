import { z } from 'zod';

import { BookingServiceKindSchema } from '../events/booking';
import { BOOKING_ID_MAX_LENGTH } from './booking-commission.schema';
import { BookingStatusSchema, BOOKING_SOFT_FK_MAX_LENGTH } from './booking.schema';
import { MemoryRecipeSchema } from './memory-recipe.schema';
import { DementiaStatusSchema, SeniorMobilityLevelSchema } from './senior-intake.schema';

/**
 * Visit prep checklist DTOs (TS-208; PRD §7.3 "Visit prep checklist"
 * — dietary, dementia-sensitive, allergies, household notes; PDD §16.3
 * trust & safety; CLAUDE.md §12 family-observability + senior consent).
 *
 * The provider-side "what do I need to know before I arrive?" surface.
 * Aggregates three sources of upstream data into one snapshot the
 * provider portal renders 24h before the visit and on-arrival:
 *
 *   - **Booking shape** — when, where (household + senior identifiers),
 *     and what kind of visit (companion dining vs. chef visit vs.
 *     concierge). The provider needs the service kind to plan
 *     mise-en-place.
 *
 *   - **Senior operational profile** — the operational columns of the
 *     senior intake (TS-031): dietary tags, allergen tags, language
 *     tags, mobility level, dementia status. The intake's encrypted
 *     payload (DOB, dietary/allergy/mobility/medical notes) is
 *     deliberately NOT included in TS-208's slice — those fields are
 *     gated on the senior-consent table that TS-062-followup-3
 *     captures; until that table lands, the provider sees only the
 *     operational categories, never the free-form narrative.
 *
 *   - **Memory recipes** — the per-senior catalog of culturally /
 *     personally meaningful dishes. Especially the ones flagged
 *     `requestedForUpcomingVisit` are the loud signal the provider
 *     should plan around.
 *
 * `.strict()` everywhere so a stray client field is a 400, never a
 * silent round-trip (CLAUDE.md §3.3).
 */

/**
 * The senior projection inside the prep checklist. **Operational only**
 * — dietary tags + allergen tags + language tags + mobility level +
 * dementia status. No sensitive payload (DOB / free-form notes /
 * medical context); those are gated on the senior-consent table and
 * land via the TS-208-followup once that infra exists.
 *
 * `intakeCompletedAt` lets the family-dashboard nudge ("the family
 * still needs to complete the intake") propagate to the provider
 * surface so the provider can call ahead if the data feels thin.
 *
 * The `seniorFirstName` field is intentionally omitted — TS-208's
 * Phase-1 slice does not surface the senior's name on the
 * provider-facing checklist (the booking row already carries the
 * `seniorId` soft-FK; the provider portal can fetch a display name
 * separately when TS-031-followup-5 wires the family-facing senior-
 * profile read). Adding it here would force a fourth upstream hop
 * for marginal value.
 */
export const VisitPrepChecklistSeniorSchema = z
  .object({
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    dietaryTags: z.array(z.string()),
    allergenTags: z.array(z.string()),
    languageTags: z.array(z.string()),
    mobilityLevel: SeniorMobilityLevelSchema,
    dementiaStatus: DementiaStatusSchema,
    intakeCompletedAt: z.string().datetime().nullable(),
  })
  .strict();
export type VisitPrepChecklistSenior = z.infer<typeof VisitPrepChecklistSeniorSchema>;

/**
 * The booking projection inside the prep checklist. Identifiers + the
 * scheduling + service-kind block — enough for the provider portal to
 * render the visit card without re-fetching the booking row itself.
 *
 * `acceptWindowExpiresAt` carries through from TS-205 so the prep
 * checklist surface can render "this booking is still pending; accept
 * by 6:42 PM" when the provider lands on the page before accepting
 * (the prep checklist is reachable from the pending-booking card per
 * TS-208's UX scope).
 */
export const VisitPrepChecklistBookingSchema = z
  .object({
    id: z.string().min(1).max(BOOKING_ID_MAX_LENGTH),
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    seniorId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    providerId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    serviceKind: BookingServiceKindSchema,
    status: BookingStatusSchema,
    scheduledStart: z.string().datetime(),
    scheduledEnd: z.string().datetime(),
    acceptWindowExpiresAt: z.string().datetime().nullable(),
    /**
     * Trust & safety hold (TS-304-followup-1). True while the visit is
     * suspended by an open incident.
     *
     * **This is the provider surface where it matters most**: the prep
     * checklist is what a provider opens on their way to a visit. Without it
     * they travel to a household for an appointment the platform has already
     * blocked. Same one-bit disclosure as `BookingResponse` — the provider may
     * themselves be the held subject, and a booking screen is not where
     * somebody learns they are under review.
     */
    onHold: z.boolean(),
  })
  .strict();
export type VisitPrepChecklistBooking = z.infer<typeof VisitPrepChecklistBookingSchema>;

/**
 * Per-page cap on memory recipes returned in the prep checklist.
 * Sized for "the page renders without scrolling" — the family catalog
 * caps at 200 recipes per senior (`MEMORY_RECIPES_MAX_PER_SENIOR`); a
 * provider rarely needs more than the most-recent + requested-for-
 * this-visit ones. Service-household sorts requested-for-upcoming-
 * visit first, then by recency, and slices to this cap.
 */
export const VISIT_PREP_MEMORY_RECIPES_MAX = 24;

/**
 * Full prep-checklist response. Returned by
 * `GET /api/v1/bookings/:bookingId/prep-checklist` (gateway BFF
 * aggregator); also the wire shape consumed by the web-provider
 * server component.
 *
 * `generatedAt` is the gateway's wall-clock time when the snapshot
 * was assembled — useful for the provider portal to surface "as of
 * 6:42 PM" without a separate round-trip + for the family-portal
 * audit trail (TS-100 records this as part of the access log).
 */
export const VisitPrepChecklistResponseSchema = z
  .object({
    booking: VisitPrepChecklistBookingSchema,
    senior: VisitPrepChecklistSeniorSchema,
    memoryRecipes: z.array(MemoryRecipeSchema).max(VISIT_PREP_MEMORY_RECIPES_MAX),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type VisitPrepChecklistResponse = z.infer<typeof VisitPrepChecklistResponseSchema>;

/**
 * Internal endpoint response — `GET /api/v1/internal/seniors/:seniorId/prep-snapshot`
 * on service-household. Pinned by a shared-secret header; the gateway
 * BFF aggregates this with the booking row + the provider's own
 * profile lookup to assemble the public-facing
 * `VisitPrepChecklistResponseSchema`.
 *
 * The shape mirrors the public response's `senior` + `memoryRecipes`
 * blocks one-to-one — the service-household projection IS those two
 * blocks. Service-household never sees the booking metadata or the
 * provider authz check; the gateway owns those.
 */
export const InternalSeniorPrepSnapshotResponseSchema = z
  .object({
    senior: VisitPrepChecklistSeniorSchema,
    memoryRecipes: z.array(MemoryRecipeSchema).max(VISIT_PREP_MEMORY_RECIPES_MAX),
  })
  .strict();
export type InternalSeniorPrepSnapshotResponse = z.infer<
  typeof InternalSeniorPrepSnapshotResponseSchema
>;
