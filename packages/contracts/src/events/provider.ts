import { z } from 'zod';

import { ProviderTierSchema } from './../http/provider-application.schema';
import { ProviderProfileTagKindSchema } from './../http/provider-profile.schema';

/**
 * Provider domain event constants + Zod schemas.
 *
 * Four events span the provider certification + tier + profile surface
 * (PRD §5.2 / §7.2 / §7.6 / §9.3; PDD §7.2 / §15.2 / §17.1):
 *
 *   - `provider.certification_granted` (TS-052-followup-1) — emitted by
 *     `ProviderCertificationsService.grant` after a successful insert
 *     into `provider.provider_certifications`. The grant is atomic
 *     with the outbox row via `prisma.$transaction`.
 *   - `provider.certification_revoked` (TS-052-followup-1) — emitted by
 *     `ProviderCertificationsService.revoke` after a successful
 *     revocation. Atomic per the same transactional rule.
 *   - `provider.tier_changed` (TS-052-followup-1) — emitted by
 *     `TierPromotionService.evaluateAndApply` /
 *     `TierPromotionService.overrideTier` when a tier transition
 *     actually lands a row in `provider.provider_tier_history`. The
 *     `providers.tier` update, the history row insert, and the outbox
 *     append all commit in a single transaction.
 *   - `provider.profile_updated` (TS-200) — emitted by
 *     `ProviderProfileService.update` whenever a provider's self-
 *     service profile edit lands. The `providers` row update, the
 *     `provider_profile_tags` replace, and the outbox append all
 *     commit in a single transaction.
 *
 * Consumers:
 *   - `apps/workers/search-indexer` (TS-053) — re-projects the
 *     provider-discovery document on tier / certification / profile
 *     changes so the Elasticsearch-backed family-portal search
 *     reflects the new state within one relay cycle. `provider.profile
 *     _updated` carries no payload diff — the indexer treats it as a
 *     "re-fetch + re-project" trigger via the discovery-snapshot read
 *     companion (`GET /api/v1/internal/providers/:providerId/
 *     discovery-snapshot`).
 *   - `service-notification` — "you earned a credential" / "your tier
 *     just changed" emails (TS-073). Profile updates are silent —
 *     no notification needed.
 *   - `service-audit` — immutable log per PDD §17.1.
 *   - `service-booking` — tier-aware gating cache invalidation
 *     (TS-064 enforces the Tier-3 households → Elite providers rule).
 *
 * Event names are dot-notation, past tense (CLAUDE.md §2.2). The
 * constants below are the single source of truth — services import
 * these literals rather than typing the strings so a rename is a TS
 * error at every call site.
 */
export const PROVIDER_CERTIFICATION_GRANTED = 'provider.certification_granted' as const;
export const PROVIDER_CERTIFICATION_REVOKED = 'provider.certification_revoked' as const;
export const PROVIDER_TIER_CHANGED = 'provider.tier_changed' as const;
export const PROVIDER_PROFILE_UPDATED = 'provider.profile_updated' as const;
export const PROVIDER_AVAILABILITY_UPDATED = 'provider.availability_updated' as const;
export const PROVIDER_SERVICE_AREAS_UPDATED = 'provider.service_areas_updated' as const;
export const PROVIDER_PRICING_UPDATED = 'provider.pricing_updated' as const;
export const PROVIDER_CALENDAR_SYNCED = 'provider.calendar_synced' as const;
export const PROVIDER_METRICS_UPDATED = 'provider.metrics_updated' as const;

/**
 * Common event envelope fields shared by every event in the catalog.
 * `eventId` is the deduplication key — consumers MUST be idempotent on
 * this (CLAUDE.md §5.3). `occurredAt` is the producer's wall-clock
 * timestamp.
 */
const EventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(128),
  occurredAt: z.string().datetime(),
});

/**
 * Tier-transition reason — mirrors the Prisma `TierTransitionReason`
 * enum (TS-052). `auto_evaluation` is fired by
 * `TierPromotionService.evaluateAndApply`; `admin_override` by
 * `TierPromotionService.overrideTier`.
 */
export const ProviderTierTransitionReasonSchema = z.enum(['auto_evaluation', 'admin_override']);
export type ProviderTierTransitionReason = z.infer<typeof ProviderTierTransitionReasonSchema>;

/**
 * `provider.certification_granted` payload.
 *
 * Carried fields are operational identifiers + the catalog code so
 * downstream consumers (search indexer, notification) can decide
 * whether to act without re-querying the provider service. The
 * `expiresAt` is nullable to mirror the issuance row — catalog rows
 * with `defaultValidityMonths = NULL` produce non-expiring grants.
 *
 * No PII beyond the `triggeredByUserId` (the ops admin who issued the
 * credential); the credential itself contains no sensitive fields.
 */
export const ProviderCertificationGrantedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  providerCertificationId: z.string().min(1).max(64),
  certificationCode: z.string().min(1).max(64),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  /**
   * `identity.users.id` of the admin who issued the credential. Null
   * for system grants (none today; the field is included so a future
   * automated path can emit through the same shape).
   */
  issuerUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderCertificationGranted = z.infer<typeof ProviderCertificationGrantedSchema>;

/**
 * `provider.certification_revoked` payload.
 *
 * `providerId` is carried alongside the issuance id so the consumer
 * can target its projection (search indexer, audit log) without a
 * round-trip back to the provider service. `revocationReason` is a
 * free-form ops-supplied string capped at 256 chars at the contract
 * boundary; the audit log preserves it verbatim.
 */
export const ProviderCertificationRevokedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  providerCertificationId: z.string().min(1).max(64),
  certificationCode: z.string().min(1).max(64),
  revocationReason: z.string().min(1).max(256),
  /**
   * `identity.users.id` of the admin who revoked the credential.
   * Null for system revocations (the auto-revoke-on-regrant path).
   */
  revokerUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderCertificationRevoked = z.infer<typeof ProviderCertificationRevokedSchema>;

/**
 * `provider.tier_changed` payload.
 *
 * Emitted only when the tier ACTUALLY changes — a no-op evaluation
 * (current tier still eligible, override target matches current) does
 * not emit. The `fromTier` is nullable to mirror the
 * `provider_tier_history.from_tier` column (the first transition for
 * a freshly-created provider may have a null `fromTier`; in practice
 * the seed sets the initial state out-of-band so this rarely fires).
 *
 * The `reason` carries the same enum the history row stores so
 * downstream consumers can branch on auto-evaluation vs.
 * admin-override semantics.
 */
export const ProviderTierChangedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  fromTier: ProviderTierSchema.nullable(),
  toTier: ProviderTierSchema,
  reason: ProviderTierTransitionReasonSchema,
  /**
   * `identity.users.id` of the actor who triggered the transition.
   * Null for purely system-driven transitions (none today; included
   * for forward compatibility with TS-052-followup-4 demotion-on-
   * expiry worker).
   */
  triggeredByUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderTierChanged = z.infer<typeof ProviderTierChangedSchema>;

/**
 * `provider.profile_updated` payload (TS-200).
 *
 * Emitted on every successful self-service profile edit — the bio /
 * tag arrays / dementia-sensitive flag change. The payload carries
 * the minimal set the search-indexer + audit-log consumers actually
 * need to act:
 *
 *   - `providerId` — the row that changed. Consumers re-project from
 *     the discovery-snapshot read companion rather than receiving a
 *     diff in the event itself; this keeps the event payload tiny
 *     and the source-of-truth single (snapshot endpoint).
 *   - `changedKinds` — the set of fields touched. `bio` / `dementia
 *     _sensitive` / `language` / `cuisine` / `dietary_expertise`.
 *     The producer emits exactly the set that changed (no field
 *     deltas — just "which kinds touched"). Consumers can skip
 *     re-projecting when the affected kinds don't influence their
 *     downstream view (e.g. notification-svc can ignore a
 *     `bio`-only change while search-indexer must always re-project).
 *   - `actorUserId` — the `identity.users.id` of the editor. Always
 *     non-null for Phase-1 self-service writes (the gateway auth
 *     stamps the actor). The field is included as nullable for
 *     forward compatibility with a future admin-override path that
 *     might attribute to a system actor.
 *
 * No PII beyond the actor id. The bio text itself is NOT in the
 * payload — consumers re-fetch via the discovery-snapshot read
 * endpoint so the event stays small + the bio doesn't appear in the
 * audit log payload (the snapshot endpoint is the audited surface
 * for "what was the bio at time T", not the event).
 */
export const ProviderProfileChangeKindSchema = z.enum([
  'bio',
  'dementia_sensitive',
  // The three tag kinds intentionally share the same literals as
  // `ProviderProfileTagKindSchema` — a profile edit that touches the
  // `language` tag set emits `language` in `changedKinds`; same for
  // `cuisine` + `dietary_expertise`. Mirroring the kinds saves
  // consumers a translation step.
  ...ProviderProfileTagKindSchema.options,
]);
export type ProviderProfileChangeKind = z.infer<typeof ProviderProfileChangeKindSchema>;

export const ProviderProfileUpdatedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  changedKinds: z.array(ProviderProfileChangeKindSchema).min(1).max(5),
  actorUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderProfileUpdated = z.infer<typeof ProviderProfileUpdatedSchema>;

/**
 * `provider.availability_updated` payload (TS-203).
 *
 * Emitted on every successful PUT / DELETE that lands at least one
 * row change on the recurring-window or date-exclusion tables. Tiny
 * payload by design — consumers re-fetch the materialised state from
 * the discovery-snapshot read endpoint rather than receive a diff in
 * the event itself.
 *
 *   - `providerId` — the row that changed.
 *   - `windowCount` / `exceptionCount` — post-write counts. Consumers
 *     (notification-svc, audit-svc) can render a "your schedule has
 *     N windows and M blackout dates" line without re-fetching;
 *     search-indexer ignores both fields and always re-projects from
 *     the snapshot.
 *   - `actorUserId` — the `identity.users.id` of the editor. Always
 *     non-null for Phase-1 self-service writes; nullable for forward
 *     compatibility with a future admin-override path or system-
 *     driven sweep (e.g. demote-on-inactivity worker).
 *
 * No PII beyond the actor id. The window / exception detail is NOT
 * in the payload — consumers re-fetch via the snapshot endpoint so
 * the event stays small + the schedule detail does not appear in
 * the audit log payload (the snapshot endpoint is the audited
 * surface for "what was the schedule at time T", not the event).
 */
export const ProviderAvailabilityUpdatedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  windowCount: z.number().int().nonnegative().max(28),
  exceptionCount: z.number().int().nonnegative().max(90),
  actorUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderAvailabilityUpdated = z.infer<typeof ProviderAvailabilityUpdatedSchema>;

/**
 * `provider.service_areas_updated` payload (TS-202).
 *
 * Emitted on every successful PUT / DELETE that lands at least one row
 * change on the `provider_service_areas` table. Tiny payload by design
 * — consumers re-fetch the materialised state (including the derived
 * centroid + bounding box) from the discovery-snapshot read endpoint
 * rather than receive the polygon geometry in the event itself.
 *
 *   - `providerId` — the row that changed.
 *   - `areaCount` — post-write count of service areas. Consumers
 *     (audit-svc) can render a "this provider now covers N areas" line
 *     without re-fetching; the search-indexer ignores the field and
 *     always re-projects from the snapshot (TS-053-followup-3, which
 *     materialises the discovery doc's `centroid` from these rows).
 *   - `actorUserId` — the `identity.users.id` of the editor. Always
 *     non-null for Phase-1 self-service writes; nullable for forward
 *     compatibility with a future admin-override path.
 *
 * No PII and no geometry in the payload — the polygon detail lives only
 * in the snapshot endpoint (the audited surface for "what was the
 * coverage at time T"), not in the event or the audit-log payload.
 */
export const ProviderServiceAreasUpdatedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  areaCount: z.number().int().nonnegative().max(10),
  actorUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderServiceAreasUpdated = z.infer<typeof ProviderServiceAreasUpdatedSchema>;

/**
 * `provider.metrics_updated` payload (TS-053-followup-4a).
 *
 * Emitted when a provider's LIFETIME COMPLETED-VISIT COUNT changes, and
 * only then. Its single consumer is the search-indexer, which
 * re-projects the provider's discovery document — `completedBookingCount`
 * is read from the `provider_metrics` rollup (TS-053-followup-4) and
 * nothing else was telling the indexer to look again, so a busy
 * provider's indexed count went stale until their next profile edit.
 *
 * **Narrow on purpose.** The metrics projector runs on all five booking
 * lifecycle events, and four of them cannot move this number: only
 * `booking.completed` sets a fact row's outcome to `completed`. Emitting
 * on each would re-project an entire search document per booking
 * transition to change an integer that did not change. If a second
 * projected figure ever lands on the discovery document, widen the
 * TRIGGER deliberately rather than letting this become "emitted
 * whenever the projector runs".
 *
 * **`eventId` is DETERMINISTIC** — `provider-metrics:{providerId}:{bookingId}`
 * — so a redelivered `booking.completed` produces the same id and the
 * outbox's `ON CONFLICT (event_id) DO NOTHING` swallows it. The fact
 * write it accompanies is already idempotent by `COALESCE`; this keeps
 * the emission idempotent too, rather than trusting the consumer to
 * absorb a duplicate re-projection.
 *
 * **The count is on the payload but the consumer must not trust it as
 * current.** It is a snapshot at emission, useful in a log line when
 * diagnosing a stale index; the re-projection re-reads the snapshot
 * endpoint like every other indexer handler (TS-053-followup-3). No PII,
 * no booking identity beyond what the event id carries, and nothing
 * about who the visit was for.
 */
export const ProviderMetricsUpdatedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  completedBookingCount: z.number().int().nonnegative(),
}).strict();
export type ProviderMetricsUpdated = z.infer<typeof ProviderMetricsUpdatedSchema>;

/**
 * `provider.pricing_updated` payload (TS-204).
 *
 * Emitted on every successful pricing PUT that actually changes the
 * provider's hourly rate / currency (a re-PUT of the identical rate
 * short-circuits before the transaction and emits nothing). Unlike the
 * profile / availability / service-area events, the pricing payload
 * carries the new value inline — the rate is a single small scalar
 * (not a polygon / schedule), and downstream consumers (search-indexer
 * for a future "price" facet, audit) can act on it without a re-fetch.
 *
 *   - `providerId` — the row that changed.
 *   - `hourlyRateMinor` — the new rate in minor units.
 *   - `currency` — the rate's ISO-4217 currency code.
 *   - `tier` — the provider's tier at write time. Carried so a
 *     consumer can confirm the rate sat inside the tier band without
 *     re-deriving the band.
 *   - `actorUserId` — the `identity.users.id` of the editor. Always
 *     non-null for Phase-1 self-service writes; nullable for forward
 *     compatibility with a future admin-override path.
 *
 * No PII beyond the actor id.
 */
export const ProviderPricingUpdatedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  hourlyRateMinor: z.number().int().min(1).max(1_000_000),
  currency: z.string().length(3),
  tier: ProviderTierSchema,
  actorUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderPricingUpdated = z.infer<typeof ProviderPricingUpdatedSchema>;

/**
 * External-calendar provider literal (TS-206). Mirrors the contract-
 * layer `ProviderCalendarProviderSchema`. Phase-1 ships `google` only;
 * `icloud` / `outlook` append (never reorder) with TS-206-followup-2.
 */
export const ProviderCalendarProviderEventSchema = z.enum(['google']);
export type ProviderCalendarProviderEvent = z.infer<typeof ProviderCalendarProviderEventSchema>;

/**
 * `provider.calendar_synced` payload (TS-206).
 *
 * Emitted whenever a provider's **external** busy mirror
 * (`provider_availability_external`) changes — on initial connect (after
 * the first free/busy pull), on a manual / scheduled re-sync, and on
 * disconnect (with `externalBusyCount: 0`). The search-indexer treats it
 * as a "re-fetch + re-project" trigger via the discovery-snapshot read
 * endpoint (same tiny-payload, re-fetch-the-snapshot convention as the
 * other provider events) so the family-portal "available this week"
 * projection reflects the unioned availability within one relay cycle.
 *
 *   - `providerId` — the row whose external availability changed.
 *   - `calendarProvider` — which external calendar drove the change.
 *   - `externalBusyCount` — post-sync count of mirrored busy intervals
 *     (0 on disconnect). Consumers (audit) can render "synced N busy
 *     windows" without re-fetching; the search-indexer ignores the count
 *     and always re-projects from the snapshot.
 *   - `actorUserId` — the `identity.users.id` of the provider who
 *     triggered the change. Nullable for the periodic background re-sync
 *     (TS-206-followup-3) where no human actor exists.
 *
 * No event content + no token material crosses the payload — only the
 * provider id + count + actor. The busy-interval detail lives only in
 * the discovery snapshot (the re-fetched, audited surface), never in the
 * event or the audit-log payload.
 */
export const ProviderCalendarSyncedSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  calendarProvider: ProviderCalendarProviderEventSchema,
  externalBusyCount: z.number().int().nonnegative().max(500),
  actorUserId: z.string().min(1).max(64).nullable(),
}).strict();
export type ProviderCalendarSynced = z.infer<typeof ProviderCalendarSyncedSchema>;

/**
 * `provider.background_check.adverse_finding` (TS-307a).
 *
 * Emitted by `service-provider` when a Checkr webhook moves the
 * background check of an **already-active** provider into an adverse
 * status. Consumed by `service-trust-safety`, which opens a `safety`
 * incident so a human reviews it.
 *
 * **Why only active providers.** An adverse result during initial
 * screening is the application flow's business — that provider is not
 * on the platform, has no bookings, and no senior is exposed. A finding
 * against someone already serving is a different question, and it is
 * the only one trust & safety should be woken for. The producer screens
 * on `providers.status`, not on the check alone.
 *
 * **The finding itself NEVER rides this event.** The payload carries
 * ids and the status transition. Everything Checkr actually reported is
 * consumer-report content under FCRA, encrypted at rest in
 * `provider_background_checks.payload_ciphertext`, and reachable only
 * through Checkr's own audited surface by someone authorised to make an
 * adverse-action decision (TS-307c). Putting any of it here would put it
 * into the Redis stream, every consumer's logs, and the incident row —
 * which is also why the incident this opens has a NULL description. The
 * ordinary no-free-text rule (CLAUDE.md §3.9, §10) points the same way;
 * this one just has a statute behind it.
 *
 *   - `providerId` — the provider row the check belongs to.
 *   - `backgroundCheckId` — the local `provider_background_checks.id`.
 *     The handle a reviewer resolves to the report; NOT the Checkr
 *     report id, which is a handle into the consumer-report system and
 *     stays inside service-provider.
 *   - `previousStatus` / `status` — the transition that fired this. Both
 *     are carried because "clear → consider" and "consider → consider"
 *     are different events to a reviewer, and the consumer must not
 *     re-derive the prior state by reading back across a service
 *     boundary.
 *   - `providerStatus` — the provider's status at emission, so the
 *     consumer can record what was true when the finding landed without
 *     a second read.
 *   - `occurredAt` — when Checkr says the event happened, not when we
 *     processed it.
 */
export const PROVIDER_BACKGROUND_CHECK_ADVERSE_FINDING =
  'provider.background_check.adverse_finding' as const;

/**
 * The background-check statuses this platform treats as adverse for an
 * active provider.
 *
 * `consider`, `suspended`, `dispute`, `failed` — each means a human must
 * look. Deliberately NOT a subset: `consider` is Checkr's "needs review"
 * and is the common case; `dispute` means the candidate is contesting a
 * finding, which is exactly when the platform must not act unilaterally;
 * `failed` covers our own conservative mapping of unknown Checkr strings,
 * so API drift surfaces as a reviewable incident rather than silence.
 *
 * `clear` and `engaged` are the healthy states. `pending` / `processing`
 * are in-flight. `canceled` is an administrative stop with nothing to
 * review.
 */
export const PROVIDER_ADVERSE_BACKGROUND_CHECK_STATUSES = [
  'consider',
  'suspended',
  'dispute',
  'failed',
] as const;

export const ProviderAdverseBackgroundCheckStatusSchema = z.enum(
  PROVIDER_ADVERSE_BACKGROUND_CHECK_STATUSES,
);
export type ProviderAdverseBackgroundCheckStatus = z.infer<
  typeof ProviderAdverseBackgroundCheckStatusSchema
>;

/** Mirrors the Prisma `BackgroundCheckStatus` enum (TS-051). */
export const ProviderBackgroundCheckStatusEventSchema = z.enum([
  'pending',
  'processing',
  'clear',
  'consider',
  'suspended',
  'engaged',
  'dispute',
  'canceled',
  'failed',
]);
export type ProviderBackgroundCheckStatusEvent = z.infer<
  typeof ProviderBackgroundCheckStatusEventSchema
>;

/** Mirrors the Prisma `ProviderStatus` enum. */
export const ProviderStatusEventSchema = z.enum([
  'pending',
  'in_review',
  'active',
  'suspended',
  'archived',
]);
export type ProviderStatusEvent = z.infer<typeof ProviderStatusEventSchema>;

export const ProviderBackgroundCheckAdverseFindingSchema = EventEnvelopeSchema.extend({
  providerId: z.string().min(1).max(64),
  backgroundCheckId: z.string().min(1).max(64),
  previousStatus: ProviderBackgroundCheckStatusEventSchema,
  status: ProviderAdverseBackgroundCheckStatusSchema,
  providerStatus: ProviderStatusEventSchema,
  occurredAt: z.string().datetime(),
}).strict();
export type ProviderBackgroundCheckAdverseFinding = z.infer<
  typeof ProviderBackgroundCheckAdverseFindingSchema
>;
