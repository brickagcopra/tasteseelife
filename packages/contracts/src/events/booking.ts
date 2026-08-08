import { z } from 'zod';

/**
 * Booking domain event constants + Zod schemas (TS-060-followup-1).
 *
 * Five events span the booking lifecycle (PRD §6.3 / PDD §9.2):
 *
 *   - `booking.created`     — POST /bookings persisted a new row in
 *                             `pending`. Consumers: notification-svc
 *                             (provider receives push + email), analytics.
 *   - `booking.confirmed`   — provider accepted: `pending` → `confirmed`.
 *                             Consumers: notification-svc (confirmation
 *                             to family), analytics.
 *   - `booking.in_progress` — provider geo-checked-in (TS-063 — currently
 *                             a manual status PATCH): `confirmed` →
 *                             `in_progress`. Consumers: notification-svc
 *                             (visit-started nudge to family), analytics.
 *   - `booking.completed`   — provider checked out + submitted notes
 *                             (TS-062): `in_progress` → `completed`.
 *                             Consumers: accounting-svc (commission
 *                             recognition — TS-083), payouts-svc
 *                             (provider payable accrual), notification-svc
 *                             (wellness summary email to family),
 *                             analytics.
 *   - `booking.canceled`    — booking canceled from any non-terminal
 *                             state. Consumers: accounting-svc
 *                             (cancellation policy / refund handling —
 *                             TS-084), notification-svc, analytics.
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The
 * constants below are the single source of truth — services import
 * these literals rather than typing the strings, so a rename is a TS
 * error at every call site.
 */
export const BOOKING_CREATED = 'booking.created' as const;
export const BOOKING_CONFIRMED = 'booking.confirmed' as const;
export const BOOKING_IN_PROGRESS = 'booking.in_progress' as const;
export const BOOKING_COMPLETED = 'booking.completed' as const;
export const BOOKING_CANCELED = 'booking.canceled' as const;
/**
 * `booking.declined` (TS-205) — emitted on `pending` → `declined`. The
 * provider rejected the inbound booking request, or the auto-decline
 * worker (TS-205-followup-1) fired when the accept window expired.
 * Consumers: `service-notification` (notify the family + route the
 * request back to the concierge queue), `service-analytics`
 * (provider-decline-rate trends), `service-concierge` (TS-221 — when
 * the concierge ticket queue lands, a decline-back-to-concierge re-
 * routes the request to a human triage workflow).
 *
 * Distinct from `booking.canceled` because the lifecycle position is
 * different: a decline happens BEFORE the provider has accepted (so
 * no commitment was made on either side), whereas a cancel happens
 * AFTER acceptance and may trigger refund / forfeit policy
 * (CLAUDE.md §6 — TS-084 cancellation policy gates off `canceled`,
 * never `declined`).
 */
export const BOOKING_DECLINED = 'booking.declined' as const;
/**
 * `booking.dispute_opened` (TS-065) — emitted when a new dispute row
 * lands on `booking_disputes`. Consumers: `service-trust-safety` (route
 * `welfare_concern` / `safety_concern` reasons into the mandated-
 * reporter workflow per CLAUDE.md §12), `service-notification` (notify
 * the counter-party — provider for family-filed disputes, family for
 * provider-filed), `service-analytics` (per-tier dispute rate trends).
 */
export const BOOKING_DISPUTE_OPENED = 'booking.dispute_opened' as const;
/**
 * `booking.dispute_resolved` (TS-065) — emitted when a dispute
 * transitions to a terminal status (`resolved` or `dismissed`).
 * Consumers: `service-accounting` (apply refund / credit policy on
 * `billing_dispute` resolutions per TS-084), `service-notification`
 * (warmly-worded outcome email to opener + counter-party),
 * `service-analytics` (time-to-resolution histograms),
 * `service-trust-safety` (closes the welfare ticket loop).
 */
export const BOOKING_DISPUTE_RESOLVED = 'booking.dispute_resolved' as const;
/**
 * `booking.tier_gating_violation` (TS-064) — emitted when
 * `BookingsService.createBooking` detects a tier mismatch under
 * CLAUDE.md §12: a Tier-3 Concierge household attempted to book a
 * provider whose tier is not `elite`. In `enforce` mode the booking is
 * rejected and this event is emitted as a record of the attempt; in
 * `advisory` mode the booking is allowed and the event is emitted as a
 * warning signal (the `mode` field distinguishes the two paths).
 *
 * Consumers: `service-trust-safety` (repeated violations from the same
 * household / actor flag for ops review per PDD §16.1),
 * `service-analytics` (per-tier mismatch trend lines).
 *
 * Carried fields are deliberately operational — no PII beyond
 * identifiers. The household and provider ids are soft FKs the
 * consumer can route on without joining back.
 */
export const BOOKING_TIER_GATING_VIOLATION = 'booking.tier_gating_violation' as const;

/**
 * Bookable service kinds — mirrors the Prisma enum in
 * `apps/service-booking/prisma/schema.prisma` (TS-060). Carried on the
 * event so consumers can route on service kind without joining back to
 * the booking row.
 *
 * The first seven are the Phase-1 basic-marketplace services (PRD §6.3);
 * the trailing six are the Tier-3 concierge experiences (PRD §6.6,
 * TS-220), each curated and Elite-provider-only. The catalog's
 * `requiredProviderTier` (see `service-catalog.schema.ts`) carries the
 * per-kind tier gate — the enum only bounds the value set.
 */
export const BookingServiceKindSchema = z.enum([
  'companion_dining',
  'personal_chef_visit',
  'grocery_coordination',
  'transportation',
  'social_outing',
  'event_dining',
  'emergency_concierge',
  // Tier-3 concierge experiences (PRD §6.6, TS-220).
  'holiday_dinner',
  'birthday_experience',
  'tea_social',
  'museum_outing',
  'memory_meal',
  'custom_request',
]);
export type BookingServiceKind = z.infer<typeof BookingServiceKindSchema>;

/**
 * Categorical cancellation reason. Free-form text lives on the
 * `cancellationReason` column for ops triage; this enum bounds the
 * machine-routable subset of the reason field for consumers (accounting
 * applies different cancellation-policy logic per category — TS-084).
 */
export const BookingCancellationReasonSchema = z.enum([
  'family_request',
  'provider_unavailable',
  'no_show',
  'welfare_concern',
  'admin_action',
  'other',
]);
export type BookingCancellationReason = z.infer<typeof BookingCancellationReasonSchema>;

/**
 * Common event envelope — every event carries `eventId` (consumer
 * dedup key per CLAUDE.md §5.3) and `occurredAt` (producer wall-clock
 * timestamp). Same shape as the subscription events for consistency.
 */
const BookingEventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * Booking-money fields carried on every event. The amounts are
 * **integer USD minor units** (cents) at the wire layer — CLAUDE.md
 * §17.6 forbids float math for money and the booking-commission
 * receiver (`service-accounting`) consumes minor units. The producer
 * (`service-booking`) stores `Decimal(12,2)` on the row and converts
 * at the boundary.
 *
 * `commissionRateBps` is the basis-points form of the rate — 0.30 →
 * 3000 bps — matching `packages/contracts/src/http/booking-commission.schema.ts`.
 */
const BookingMoneyFieldsSchema = z.object({
  currency: z.string().length(3),
  basePriceMinor: z.number().int().min(0),
  commissionRateBps: z.number().int().min(0).max(10_000),
  commissionAmountMinor: z.number().int().min(0),
  finalPriceMinor: z.number().int().min(0),
});

/**
 * Identifiers carried on every event. Captured up-front so consumers
 * never need to join back to the booking row for routing.
 *
 * `householdId` / `seniorId` / `providerId` are soft FKs into the
 * household + provider service schemas (CLAUDE.md §2.3 — cross-service
 * FKs forbidden; the join lives at the gateway BFF or via events).
 */
const BookingIdentifiersSchema = z.object({
  bookingId: z.string().min(1).max(64),
  householdId: z.string().min(1).max(64),
  seniorId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(64),
  serviceKind: BookingServiceKindSchema,
});

const BookingScheduleSchema = z.object({
  scheduledStart: z.string().datetime(),
  scheduledEnd: z.string().datetime(),
});

/**
 * Max length of the search-correlation token echoed on `booking.created`
 * (TS-217-prep-4c). Matches the `searchId` shape minted on
 * `SearchProvidersResponse` (TS-217-prep-4a) + carried on
 * `search.result_clicked` (`SEARCH_RESULT_CLICKED_ID_MAX_LENGTH` = 128),
 * so the same token threads search → click → booking unchanged.
 */
export const BOOKING_SEARCH_ID_MAX_LENGTH = 128;

/**
 * `booking.created` — emitted from `POST /api/v1/bookings` after the
 * row commits in `pending`. Consumers know the full booking metadata
 * without needing to fetch.
 *
 * **`searchId` (TS-217-prep-4c).** The optional search-correlation token
 * the family-portal received on `SearchProvidersResponse` (TS-217-prep-4a)
 * and threaded through the provider-detail / request-a-visit flow into the
 * create call. Echoing it here lets `service-analytics` attribute a booking
 * to the exact originating search (join `booking.created.searchId ===
 * search.performed.eventId`), turning the prep-3b APPROXIMATE
 * household/time-window conversion funnel into a PRECISE per-search
 * query→booking attribution. Nullish (optional + nullable): a booking that
 * did not originate from a search (concierge manual booking, a direct
 * provider-link visit) carries `null` / omits it. Additive + backward-
 * compatible — events emitted before this field landed validate unchanged
 * (CLAUDE.md §5.3 event evolution).
 */
export const BookingCreatedSchema = BookingEventEnvelopeSchema.merge(BookingIdentifiersSchema)
  .merge(BookingScheduleSchema)
  .merge(BookingMoneyFieldsSchema)
  .extend({
    searchId: z.string().min(1).max(BOOKING_SEARCH_ID_MAX_LENGTH).nullish(),
  })
  .strict();
export type BookingCreated = z.infer<typeof BookingCreatedSchema>;

/**
 * `booking.confirmed` — emitted on `pending` → `confirmed`.
 */
export const BookingConfirmedSchema = BookingEventEnvelopeSchema.merge(BookingIdentifiersSchema)
  .merge(BookingScheduleSchema)
  .extend({
    confirmedAt: z.string().datetime(),
  })
  .strict();
export type BookingConfirmed = z.infer<typeof BookingConfirmedSchema>;

/**
 * `booking.in_progress` — emitted on `confirmed` → `in_progress`. The
 * geo-check-in payload arrives in TS-063 as a separate event; this
 * event signals "the visit has started" so the family-portal UI can
 * render the in-progress state.
 */
export const BookingInProgressSchema = BookingEventEnvelopeSchema.merge(BookingIdentifiersSchema)
  .extend({
    startedAt: z.string().datetime(),
  })
  .strict();
export type BookingInProgress = z.infer<typeof BookingInProgressSchema>;

/**
 * `booking.completed` — emitted on `in_progress` → `completed`. The
 * canonical consumer is `service-accounting`'s booking-commission
 * recognizer (TS-083), which derives the four-line journal entry from
 * the payload's money fields. PDD Appendix A.
 *
 * Money fields are carried in **integer minor units** to match the
 * accounting recognizer's contract (`BookingCommissionRequestSchema`).
 * The recognizer expects the invariant
 * `grossAmountMinor == providerAmountMinor + marketplaceAmountMinor`;
 * the event carries `marketplaceAmountMinor` separately so the
 * consumer doesn't have to rederive it from the rate.
 */
export const BookingCompletedSchema = BookingEventEnvelopeSchema.merge(BookingIdentifiersSchema)
  .extend({
    completedAt: z.string().datetime(),
    currency: z.string().length(3),
    grossAmountMinor: z.number().int().min(0),
    providerAmountMinor: z.number().int().min(0),
    marketplaceAmountMinor: z.number().int().min(0),
    commissionRateBps: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.providerAmountMinor + body.marketplaceAmountMinor !== body.grossAmountMinor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'gross must equal provider + marketplace (booking-commission recognizer requires this invariant)',
        path: ['grossAmountMinor'],
      });
    }
  });
export type BookingCompleted = z.infer<typeof BookingCompletedSchema>;

/**
 * `booking.canceled` — emitted on any (non-terminal) → `canceled`
 * transition.
 *
 * `previousStatus` lets the consumer (accounting-svc cancellation
 * policy in TS-084) decide whether a refund is due — a cancellation
 * from `pending` typically forfeits nothing (no charge yet), whereas a
 * cancellation from `confirmed` may trigger a partial refund per
 * policy.
 *
 * `cancellationReason` carries the categorical reason; the free-form
 * text stays on the booking row for ops review and is NOT carried on
 * the event (PII discipline — CLAUDE.md §3.9).
 */
export const BookingCanceledSchema = BookingEventEnvelopeSchema.merge(BookingIdentifiersSchema)
  .extend({
    canceledAt: z.string().datetime(),
    previousStatus: z.enum(['pending', 'confirmed', 'in_progress']),
    cancellationReason: BookingCancellationReasonSchema,
    canceledByUserId: z.string().min(1).max(64),
  })
  .strict();
export type BookingCanceled = z.infer<typeof BookingCanceledSchema>;

/**
 * Decline kind — categorises WHO drove the `pending` → `declined`
 * transition. Stamped server-side from the actor context, never
 * client-supplied (CLAUDE.md §3.2).
 *
 *   - `provider_declined` — the assigned provider explicitly rejected
 *     the request via `POST /api/v1/bookings/:id/decline` (TS-205).
 *   - `window_expired`    — the auto-decline worker (TS-205-followup-1)
 *     fired after `BOOKING_ACCEPT_WINDOW_MINUTES` elapsed without an
 *     accept. Phase-1 stop-gap: the accept endpoint refuses an accept
 *     past the window even without the worker running, so a row can
 *     reach `declined` via this kind once the worker lands.
 *   - `admin_declined`    — concierge / ops staff declined on the
 *     provider's behalf (TS-128 admin override).
 */
export const BookingDeclineKindSchema = z.enum([
  'provider_declined',
  'window_expired',
  'admin_declined',
]);
export type BookingDeclineKind = z.infer<typeof BookingDeclineKindSchema>;

/**
 * Categorical decline reason — bounded set the provider portal
 * surfaces in a dropdown so trust-safety / analytics can route without
 * parsing prose. The free-form `declineReasonText` (on the row, not
 * the event) carries the narrative for ops triage.
 *
 *   - `schedule_conflict`   — provider double-booked at the time.
 *   - `outside_service_area` — the visit address falls outside the
 *     provider's declared service area.
 *   - `dietary_mismatch`    — the senior's dietary needs sit outside
 *     the provider's specialty (e.g., kosher request to a non-kosher
 *     chef).
 *   - `safety_concern`      — the provider has a safety-related
 *     concern about the booking (e.g., unsafe access instructions).
 *     Trust-safety surfaces this for review.
 *   - `other`               — catch-all; encourages `declineReasonText`.
 */
export const BookingDeclineReasonSchema = z.enum([
  'schedule_conflict',
  'outside_service_area',
  'dietary_mismatch',
  'safety_concern',
  'other',
]);
export type BookingDeclineReason = z.infer<typeof BookingDeclineReasonSchema>;

/**
 * `booking.declined` (TS-205) — emitted on `pending` → `declined`.
 *
 * Carries enough information for consumers (`service-notification`
 * surfacing the family "your request was declined" email + the
 * concierge re-routing trigger; `service-analytics` decline-rate
 * trend lines; `service-concierge` (TS-221) requeue handoff) without
 * joining back to the booking row.
 *
 * No PII beyond identifiers. The free-form `declineReasonText` lives
 * only on the booking row and is NOT echoed onto the event
 * (CLAUDE.md §3.9 — PII discipline). Consumers that genuinely need
 * the narrative (admin triage tools) fetch it from the row.
 */
export const BookingDeclinedSchema = BookingEventEnvelopeSchema.merge(BookingIdentifiersSchema)
  .merge(BookingScheduleSchema)
  .extend({
    declinedAt: z.string().datetime(),
    declineKind: BookingDeclineKindSchema,
    /**
     * Categorical reason. Nullable when the decline kind is
     * `window_expired` (the worker has no reason input from a human).
     * Required for `provider_declined` / `admin_declined` at the
     * contract layer — the request DTO enforces it via superRefine.
     */
    declineReason: BookingDeclineReasonSchema.nullable(),
    /**
     * Actor that recorded the decline. For `provider_declined`, the
     * provider's `userId`. For `admin_declined`, the admin's `userId`.
     * For `window_expired`, a synthetic system-actor id stamped by the
     * worker (e.g. `sys:booking-window-watcher`). Always present so
     * the audit trail records WHO triggered the transition.
     */
    declinedByUserId: z.string().min(1).max(64),
  })
  .strict();
export type BookingDeclined = z.infer<typeof BookingDeclinedSchema>;

/**
 * Dispute reason — mirrors the Prisma `booking_dispute_reason` enum
 * (TS-065). Carried on the dispute events so consumers can route on
 * category without joining back to the booking_disputes row.
 *
 * `welfare_concern` is first-class (CLAUDE.md §12); the
 * `service-trust-safety` consumer routes this category into the
 * mandated-reporter workflow.
 */
export const BookingDisputeReasonSchema = z.enum([
  'no_show',
  'late_arrival',
  'early_departure',
  'service_quality',
  'billing_dispute',
  'property_damage',
  'safety_concern',
  'welfare_concern',
  'other',
]);
export type BookingDisputeReason = z.infer<typeof BookingDisputeReasonSchema>;

/**
 * Dispute opener role — mirrors the Prisma
 * `booking_dispute_opener_role` enum. Server-stamped from the
 * authenticated request context (never client-supplied;
 * CLAUDE.md §3.2).
 */
export const BookingDisputeOpenedByRoleSchema = z.enum(['family', 'provider', 'admin']);
export type BookingDisputeOpenedByRole = z.infer<typeof BookingDisputeOpenedByRoleSchema>;

/**
 * Dispute terminal outcome — the consumer-facing union of resolved /
 * dismissed at resolution time. Mirrors the Prisma
 * `booking_dispute_status` enum's two terminal variants.
 */
export const BookingDisputeOutcomeSchema = z.enum(['resolved', 'dismissed']);
export type BookingDisputeOutcome = z.infer<typeof BookingDisputeOutcomeSchema>;

/**
 * `booking.dispute_opened` — emitted from `POST /api/v1/bookings/:id/disputes`
 * after the row commits in `open`. Carries enough information for
 * consumers to route without joining back to the dispute row:
 *
 *   - `disputeId` / `bookingId` — identifiers.
 *   - `householdId` / `providerId` — soft FKs into the household + provider
 *     service schemas, so consumers (notification, trust-safety,
 *     analytics) don't need a gateway join.
 *   - `openedByUserId` / `openedByRole` — who filed.
 *   - `reason` — categorical reason (trust-safety routes on this).
 *   - `hasReasonDetail` — boolean rather than the freeform text itself,
 *     so PII isn't carried on the bus (CLAUDE.md §3.9 PII discipline).
 *
 * The freeform `reasonDetail` lives only on the dispute row and is
 * fetched by consumers that have a legitimate need (admin tooling, the
 * trust-safety triage UI).
 */
export const BookingDisputeOpenedSchema = BookingEventEnvelopeSchema.extend({
  disputeId: z.string().min(1).max(64),
  bookingId: z.string().min(1).max(64),
  householdId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(64),
  openedByUserId: z.string().min(1).max(64),
  openedByRole: BookingDisputeOpenedByRoleSchema,
  reason: BookingDisputeReasonSchema,
  hasReasonDetail: z.boolean(),
}).strict();
export type BookingDisputeOpened = z.infer<typeof BookingDisputeOpenedSchema>;

/**
 * `booking.dispute_resolved` — emitted when a dispute transitions to a
 * terminal status (`resolved` or `dismissed`). Carries:
 *
 *   - `outcome` — categorical terminal status.
 *   - `resolvedByUserId` — actor that drove the resolution.
 *   - `reason` — original categorical reason (echoed so consumers don't
 *     need to fetch the row to route).
 *   - `hasResolutionNotes` — boolean (PII bracket, same as
 *     `hasReasonDetail` on the open event).
 *
 * `service-accounting` consumes this for `billing_dispute` outcomes
 * (TS-084 refund-policy application); `service-notification` for the
 * outcome email; `service-trust-safety` for ticket closure.
 */
export const BookingDisputeResolvedSchema = BookingEventEnvelopeSchema.extend({
  disputeId: z.string().min(1).max(64),
  bookingId: z.string().min(1).max(64),
  householdId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(64),
  outcome: BookingDisputeOutcomeSchema,
  resolvedByUserId: z.string().min(1).max(64),
  reason: BookingDisputeReasonSchema,
  hasResolutionNotes: z.boolean(),
}).strict();
export type BookingDisputeResolved = z.infer<typeof BookingDisputeResolvedSchema>;

/**
 * Tier-gating violation mode — distinguishes whether the violation
 * blocked the booking (`enforce`) or merely logged it (`advisory`).
 * Mirrors `BOOKING_TIER_GATING_MODE` env on service-booking
 * (TS-064; PRD §5.1 / §5.2; CLAUDE.md §12).
 */
export const BookingTierGatingModeSchema = z.enum(['enforce', 'advisory']);
export type BookingTierGatingMode = z.infer<typeof BookingTierGatingModeSchema>;

/**
 * Tier-gating violation reason — narrows the producer's reason for
 * emitting the event so consumers can route without parsing prose.
 *
 *   - `tier_3_requires_elite` — Tier-3 Concierge household attempted to
 *     book a provider whose tier is not `elite`. The canonical
 *     CLAUDE.md §12 per-household gate.
 *   - `household_snapshot_unknown` — the household snapshot is missing
 *     from service-booking's cache. Emitted only in `enforce` mode
 *     (in `advisory` mode the absence is a log + metric, not a domain
 *     event — there is no actual rule violation to record).
 *   - `provider_snapshot_unknown` — mirror reason for the provider side.
 *   - `service_kind_requires_higher_tier` (TS-220-followup-1) — the
 *     booked service kind carries a `service_catalog.required_provider_tier`
 *     (e.g. the Tier-3 concierge experiences in PRD §6.6 require
 *     `elite`) and the assigned provider's tier ranks below it. The
 *     per-service-kind counterpart of `tier_3_requires_elite` — it
 *     catches the case the per-household gate misses (a Tier-1/Tier-2
 *     household booking a concierge experience with a non-elite
 *     provider). CLAUDE.md §12.
 */
export const BookingTierGatingViolationReasonSchema = z.enum([
  'tier_3_requires_elite',
  'household_snapshot_unknown',
  'provider_snapshot_unknown',
  'service_kind_requires_higher_tier',
]);
export type BookingTierGatingViolationReason = z.infer<
  typeof BookingTierGatingViolationReasonSchema
>;

/**
 * Household subscription tier — mirrors the booking-side
 * `HouseholdSubscriptionTier` enum and the PRD §5.1 family-membership
 * taxonomy. Re-declared here (rather than imported from the http
 * schema) so the events module has no cross-package dependency on the
 * http module.
 */
const HouseholdSubscriptionTierEventSchema = z.enum([
  'tier_1_essential',
  'tier_2_companion',
  'tier_3_concierge',
]);

/**
 * Provider tier — mirrors service-provider's `ProviderTier` enum.
 * Re-declared here for the same reason as the household enum above.
 */
const ProviderTierEventSchema = z.enum(['basic', 'certified', 'elite']);

/**
 * `booking.tier_gating_violation` (TS-064) — emitted when
 * `BookingsService.createBooking` detects a tier mismatch or a missing
 * tier snapshot under the CLAUDE.md §12 gate. Carries enough
 * information for consumers (trust-safety, analytics) to route without
 * joining back to the (rejected) booking attempt — there is no
 * persisted booking row in `enforce` mode.
 *
 *   - `attemptId` — synthetic id assigned by the producer (mirrors the
 *     booking-id shape so the event is greppable in operational tools).
 *   - `mode` — which enforcement mode was active.
 *   - `reason` — categorical reason (see `BookingTierGatingViolationReasonSchema`).
 *   - `householdId` / `providerId` — soft FKs.
 *   - `householdTier` / `providerTier` — nullable. The tier read from
 *     the cache; null when the corresponding snapshot is missing.
 *   - `actorUserId` — who attempted the booking.
 *   - `serviceKind` — the bookable service kind the family attempted.
 *
 * No PII beyond identifiers. Free-form booking notes are deliberately
 * not echoed onto the event.
 */
export const BookingTierGatingViolationSchema = BookingEventEnvelopeSchema.extend({
  attemptId: z.string().min(1).max(64),
  mode: BookingTierGatingModeSchema,
  reason: BookingTierGatingViolationReasonSchema,
  householdId: z.string().min(1).max(64),
  providerId: z.string().min(1).max(64),
  householdTier: HouseholdSubscriptionTierEventSchema.nullable(),
  providerTier: ProviderTierEventSchema.nullable(),
  actorUserId: z.string().min(1).max(64),
  serviceKind: BookingServiceKindSchema,
}).strict();
export type BookingTierGatingViolation = z.infer<typeof BookingTierGatingViolationSchema>;

// ─────────────────────────────────────────────────────────────────────
// Anomaly detection (TS-308a)
// ─────────────────────────────────────────────────────────────────────

/**
 * `booking.anomaly.impossible_travel` (TS-308a; PRD §10.13, PDD §17.3).
 *
 * Emitted by `service-booking`'s detection sweep when two consecutive
 * check-ins by the same provider sit further apart than the elapsed
 * time between them could plausibly cover. Consumed by
 * `service-trust-safety`, which opens a `safety` incident so a human
 * looks.
 *
 * **Why this signal and not the one PDD §17.3 describes.** The original
 * framing was "a user account with bookings in two distant cities within
 * an hour". Bookings on this platform carry no coordinates at all, and a
 * family with visits in two cities is a family with a parent in each —
 * a customer, not an anomaly. The check-in is the only geo the platform
 * records, it is stamped server-side from the provider's device, and a
 * provider registering arrivals 200 km apart twenty minutes apart is
 * either a spoofed check-in or a different person working the visit.
 * Both are safety events. See TS-308's decomposition.
 *
 * **The COORDINATES NEVER RIDE THIS EVENT.** A check-in location is a
 * senior's home address expressed as a decimal pair, and CLAUDE.md §12
 * explicitly holds location data back even from the family portal. What
 * crosses the wire is the derived scalar — how far, how long, how fast —
 * plus the two check-in ids, which a reviewer with the right permission
 * resolves inside service-booking. That keeps the address out of the
 * Redis stream, every consumer's logs, and the incident row (whose
 * description is therefore null, as in TS-307a).
 *
 * **The producer states a fact; the consumer grades it.** This event
 * says "these two check-ins imply 940 km/h". Whether that is `high` or
 * `medium` on this platform is trust & safety's judgement, exactly as in
 * TS-304 (pointing the other way) and TS-307a.
 *
 *   - `providerId` — the provider whose check-ins these are.
 *   - `previousCheckInId` / `checkInId` — the pair, oldest first. The
 *     handles a reviewer resolves to the actual locations.
 *   - `previousBookingId` / `bookingId` — the visits they belong to,
 *     so a reviewer lands on the two appointments without a join.
 *   - `distanceMeters` — great-circle distance between the two points,
 *     rounded to whole metres. Precision beyond that would start to
 *     re-encode the coordinates.
 *   - `elapsedSeconds` — always >= 1. Two check-ins sharing a timestamp
 *     are screened out by the producer rather than emitted as an
 *     infinite speed.
 *   - `impliedSpeedKph` — the derived figure the threshold was compared
 *     against, rounded to one decimal. Carried so the consumer and any
 *     later reviewer see the same number the detector saw, even if the
 *     threshold is retuned afterwards.
 *   - `thresholdKph` — the ceiling in force at detection time. A
 *     retuned threshold must not silently rewrite the history of why an
 *     old incident was opened.
 *   - `previousOccurredAt` / `occurredAt` — the two check-in timestamps.
 *     `occurredAt` is the LATER one (the envelope's producer-clock
 *     convention holds: it is when the thing being reported happened,
 *     not when the sweep noticed).
 */
export const BOOKING_ANOMALY_IMPOSSIBLE_TRAVEL = 'booking.anomaly.impossible_travel' as const;

export const BookingAnomalyImpossibleTravelSchema = BookingEventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  previousCheckInId: z.string().min(1).max(64),
  checkInId: z.string().min(1).max(64),
  previousBookingId: z.string().min(1).max(64),
  bookingId: z.string().min(1).max(64),
  distanceMeters: z.number().int().min(0),
  elapsedSeconds: z.number().int().min(1),
  impliedSpeedKph: z.number().nonnegative(),
  thresholdKph: z.number().positive(),
  previousOccurredAt: z.string().datetime(),
}).strict();
export type BookingAnomalyImpossibleTravel = z.infer<typeof BookingAnomalyImpossibleTravelSchema>;

/**
 * `booking.anomaly.mass_cancellation` (TS-308c; PRD §10.13, PDD §17.3;
 * CLAUDE.md §12).
 *
 * Emitted by `service-booking`'s detection sweep when one subject — a
 * provider or a household — accumulates an unusual number of separate
 * cancellation decisions inside a rolling window. Consumed by
 * `service-trust-safety`, which opens an incident so a human looks.
 *
 * **The subject is who the cancellations are ABOUT, not who pressed the
 * button.** `bookings` records `canceled_at` and (from TS-308c)
 * `canceled_by_user_id`, but service-booking cannot map a user id to
 * "the provider" or "a member of this household" — that lookup lives in
 * two other services and CLAUDE.md §2.3 forbids reaching for it. So the
 * detector counts by the two subjects the row already names:
 *
 *   - `provider` — visits assigned to this provider that were cancelled,
 *     whoever cancelled them. A provider's day of care evaporating is a
 *     continuity event for several families at once regardless of who
 *     initiated it.
 *   - `household` — this household's visits that were cancelled.
 *
 * `distinctActorCount` is what lets a reviewer tell those apart without
 * the role lookup: eight cancellations by ONE actor is one person
 * walking away from a day's commitments; eight by EIGHT actors is
 * several families independently deciding the same thing about the same
 * provider. Both are worth a look; they are not the same event.
 *
 * **A cancelled recurring series counts ONCE.** A family whose senior is
 * hospitalised cancels a twelve-week series in a single decision, and
 * counting that as twelve would make the most sympathetic case on the
 * platform the one the detector fires on hardest. The threshold is
 * therefore compared against `distinctCancellationCount`, which collapses
 * every occurrence sharing a `series_id` into one; `canceledBookingCount`
 * carries the raw number of visits so the reviewer still sees the size of
 * what happened.
 *
 * **No free text and no reasons ride this event.** The categorical
 * cancellation reason (`welfare_concern`, `no_show`, …) would be useful
 * triage colour, and it is deliberately left off: a per-row reason
 * breakdown says something about a named senior's circumstances, and the
 * reviewer already has permission-gated access to the bookings
 * themselves. What crosses the wire is counts and a window.
 *
 *   - `subjectKind` / `subjectId` — who the cancellations are about.
 *   - `windowStart` / `windowEnd` — the rolling window examined.
 *     `windowEnd` is the sweep's clock; `occurredAt` on the envelope is
 *     the same instant (a window breach has no single moment).
 *   - `windowBucket` — the UTC calendar date (`YYYY-MM-DD`) the breach
 *     was attributed to. Part of the deterministic event id, so one
 *     subject produces at most ONE event per day however many times the
 *     sweep re-observes the same window. UTC deliberately: the detector
 *     has one clock, not one per tenant.
 *   - `canceledBookingCount` — raw cancelled visits in the window.
 *   - `distinctCancellationCount` — those collapsed per recurring
 *     series. **This is the number compared against the threshold.**
 *   - `threshold` — the value in force at detection time, so a retuned
 *     threshold does not silently rewrite why an old incident opened.
 *   - `distinctActorCount` — distinct non-null `canceled_by_user_id`
 *     values among the raw rows.
 *   - `unattributedCount` — raw rows with no recorded actor. Non-zero
 *     for bookings cancelled before TS-308c added the column; a
 *     reviewer needs to know the actor count is a floor, not a fact.
 *   - `staffExcludedCount` — raw rows cancelled by a member of platform
 *     STAFF, which are excluded from every count above
 *     (TS-308c-followup-3). When a provider leaves the platform, ops
 *     cancels their remaining bookings: one admin acting once, which
 *     tripped the provider threshold immediately and opened a
 *     `conduct` incident on somebody who had already gone. That is the
 *     single known false-positive mode of this detector, and tuning the
 *     threshold down while it exists would fit the threshold to noise.
 *     The count still RIDES the event rather than vanishing, because
 *     "four cancellations, and eight more by us" and "four
 *     cancellations" are different situations and the reviewer must be
 *     able to tell them apart.
 */
export const BOOKING_ANOMALY_MASS_CANCELLATION = 'booking.anomaly.mass_cancellation' as const;

/**
 * Which subject a mass-cancellation finding is about. Mirrors the two
 * `bookings` columns the detector can group by without a cross-service
 * lookup. Deliberately NOT a "senior" kind: a senior's visits are a
 * strict subset of their household's, so a senior-level count would
 * double-report the same behaviour at a finer grain.
 */
export const BookingAnomalySubjectKindSchema = z.enum(['provider', 'household']);
export type BookingAnomalySubjectKind = z.infer<typeof BookingAnomalySubjectKindSchema>;

export const BookingAnomalyMassCancellationSchema = BookingEventEnvelopeSchema.extend({
  subjectKind: BookingAnomalySubjectKindSchema,
  subjectId: z.string().min(1).max(64),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  windowBucket: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  canceledBookingCount: z.number().int().min(1),
  distinctCancellationCount: z.number().int().min(1),
  threshold: z.number().int().min(1),
  distinctActorCount: z.number().int().min(0),
  unattributedCount: z.number().int().min(0),
  staffExcludedCount: z.number().int().min(0),
}).strict();
export type BookingAnomalyMassCancellation = z.infer<typeof BookingAnomalyMassCancellationSchema>;
