import { z } from 'zod';

import { BOOKING_SOFT_FK_MAX_LENGTH } from './booking.schema';

/**
 * Booking tier-snapshot HTTP DTOs (TS-064; PRD §5.1 / §5.2; CLAUDE.md §12).
 *
 * service-booking enforces "Tier 3 (Concierge) households can only book
 * Elite Concierge providers" at the SERVICE LAYER. The booking service
 * does not own household or provider tier — those live in
 * service-subscription and service-provider respectively. Per
 * CLAUDE.md §2.3 cross-service joins are forbidden; the booking service
 * maintains its own read-side cache of tier snapshots, hydrated either
 * by the `subscription.tier_changed` / `provider.tier_changed` events
 * (lands with TS-142 outbox + relay) or by the Phase-1 internal HTTP
 * endpoints whose contracts are defined in this file.
 *
 * Two internal endpoints (shared-secret pinned, mirrors the established
 * service-identity KYC internal-dispatch pattern from TS-026):
 *
 *   POST /api/v1/internal/booking/tier-snapshots/household
 *     Upsert (or insert) a household tier snapshot. Body carries the
 *     household id, the categorical tier, an ISO 8601 producer-side
 *     timestamp, and an optional source event id (set when the
 *     producer is the event consumer; null when called by ops /
 *     gateway BFF).
 *
 *   POST /api/v1/internal/booking/tier-snapshots/provider
 *     Mirror endpoint for provider tier snapshots.
 *
 * Both endpoints return the upserted row shape.
 *
 * **`.strict()` everywhere** — unknown fields parse-fail so a typo
 * doesn't silently round-trip (CLAUDE.md §3.3).
 */

/**
 * Cap on the producer-side source-event-id when the snapshot is
 * hydrated via TS-142 event consumption. Mirrors the booking event
 * envelope's `eventId` cap (`packages/contracts/src/events/booking.ts`).
 */
export const TIER_SNAPSHOT_SOURCE_EVENT_ID_MAX_LENGTH = 128;

/**
 * Household subscription tier — mirrors the Prisma
 * `household_subscription_tier` enum (TS-064). Three-variant taxonomy
 * matching PRD §5.1 family-membership tiers (Essential / Companion
 * Dining / Concierge Lifestyle).
 *
 * `tier_3_concierge` is the GATED variant — Tier-3 households can only
 * book Elite Concierge providers per CLAUDE.md §12. Other tiers can
 * book any provider tier (no upward gate).
 */
export const HouseholdSubscriptionTierSchema = z.enum([
  'tier_1_essential',
  'tier_2_companion',
  'tier_3_concierge',
]);
export type HouseholdSubscriptionTier = z.infer<typeof HouseholdSubscriptionTierSchema>;

/**
 * Provider tier — mirrors service-provider's `ProviderTier` enum.
 * Three variants matching PRD §5.2 provider tiers (Basic / Certified
 * Culinary Companion / Elite Concierge Provider).
 *
 * `elite` is the only tier eligible to fulfil a Tier-3 Concierge
 * household's booking per CLAUDE.md §12.
 */
export const ProviderTierSnapshotTierSchema = z.enum(['basic', 'certified', 'elite']);
export type ProviderTierSnapshotTier = z.infer<typeof ProviderTierSnapshotTierSchema>;

/**
 * Upsert household tier snapshot request. The caller (ops via the
 * gateway BFF, or eventually the `subscription.tier_changed` consumer)
 * supplies the household id + the categorical tier + the producer-side
 * timestamp. Source event id is optional — set when called by an event
 * consumer so the row records the lineage.
 */
export const UpsertHouseholdTierSnapshotRequestSchema = z
  .object({
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    tier: HouseholdSubscriptionTierSchema,
    lastSyncedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(TIER_SNAPSHOT_SOURCE_EVENT_ID_MAX_LENGTH).optional(),
  })
  .strict();
export type UpsertHouseholdTierSnapshotRequest = z.infer<
  typeof UpsertHouseholdTierSnapshotRequestSchema
>;

/**
 * Upsert provider tier snapshot request. Mirrors
 * `UpsertHouseholdTierSnapshotRequest` for the provider side.
 */
export const UpsertProviderTierSnapshotRequestSchema = z
  .object({
    providerId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    tier: ProviderTierSnapshotTierSchema,
    lastSyncedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(TIER_SNAPSHOT_SOURCE_EVENT_ID_MAX_LENGTH).optional(),
  })
  .strict();
export type UpsertProviderTierSnapshotRequest = z.infer<
  typeof UpsertProviderTierSnapshotRequestSchema
>;

/**
 * Household tier snapshot response — the upserted row shape.
 *
 * `sourceEventId` is `string | null` on the wire because the column is
 * nullable in the database (the ops/gateway HTTP path leaves it null;
 * the event-consumer path sets it). `createdAt` and `updatedAt` are
 * server-stamped — the wire shape reflects the persisted row.
 */
export const HouseholdTierSnapshotResponseSchema = z
  .object({
    householdId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    tier: HouseholdSubscriptionTierSchema,
    lastSyncedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(TIER_SNAPSHOT_SOURCE_EVENT_ID_MAX_LENGTH).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type HouseholdTierSnapshotResponse = z.infer<typeof HouseholdTierSnapshotResponseSchema>;

/**
 * Provider tier snapshot response — mirror shape of
 * `HouseholdTierSnapshotResponse`.
 */
export const ProviderTierSnapshotResponseSchema = z
  .object({
    providerId: z.string().min(1).max(BOOKING_SOFT_FK_MAX_LENGTH),
    tier: ProviderTierSnapshotTierSchema,
    lastSyncedAt: z.string().datetime(),
    sourceEventId: z.string().min(1).max(TIER_SNAPSHOT_SOURCE_EVENT_ID_MAX_LENGTH).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderTierSnapshotResponse = z.infer<typeof ProviderTierSnapshotResponseSchema>;
