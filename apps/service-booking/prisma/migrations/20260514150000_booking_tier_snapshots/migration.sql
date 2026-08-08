-- TS-064 — Booking tier gating (PRD §5.1, §5.2; CLAUDE.md §12).
--
-- service-booking enforces "Tier 3 (Concierge) households can only book
-- Elite Concierge providers" at the SERVICE LAYER. The booking service
-- does NOT own household or provider tier — those live in
-- service-subscription and service-provider respectively. Per
-- CLAUDE.md §2.3 cross-service joins are forbidden; instead the booking
-- service maintains its own denormalised read-side cache of household
-- + provider tier snapshots, hydrated either by the eventual
-- subscription.tier_changed / provider.tier_changed events (lands with
-- TS-142 outbox + relay) or by the Phase-1 internal HTTP endpoints
-- shipped in this slice (shared-secret pinned; ops / gateway writes).
--
-- Two enums + two tables. Both tables are PK'd by the soft FK id so the
-- upsert path is a `WHERE id = ?` against a primary key.
--
-- Reversal plan (forward-only expand → migrate → contract):
--   DROP TABLE booking.provider_tier_snapshots;
--   DROP TABLE booking.household_tier_snapshots;
--   DROP TYPE booking.provider_tier_snapshot_tier;
--   DROP TYPE booking.household_subscription_tier;
-- Safe in isolation — no other service schema references these objects.

CREATE TYPE "booking"."household_subscription_tier" AS ENUM (
    'tier_1_essential',
    'tier_2_companion',
    'tier_3_concierge'
);

CREATE TYPE "booking"."provider_tier_snapshot_tier" AS ENUM (
    'basic',
    'certified',
    'elite'
);

-- Household subscription tier snapshot.
--
-- One row per household; the household id is the primary key so the
-- upsert path is a `WHERE household_id = ?` against a PK index. Tier
-- values mirror the PRD §5.1 family-membership taxonomy
-- (Essential / Companion Dining / Concierge Lifestyle). The
-- `source_event_id` column records the producer-side event-id when the
-- row was last hydrated from an event (`subscription.tier_changed`);
-- writes from the internal HTTP endpoint leave it null. The
-- `last_synced_at` column records the producer-side timestamp.
CREATE TABLE "booking"."household_tier_snapshots" (
    "household_id" TEXT NOT NULL,
    "tier" "booking"."household_subscription_tier" NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL,
    "source_event_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "household_tier_snapshots_pkey" PRIMARY KEY ("household_id")
);

-- Provider tier snapshot.
--
-- Mirrors `household_tier_snapshots`. Tier values mirror the
-- `provider.provider_tier` enum in service-provider's schema
-- (PRD §5.2 — Basic / Certified Culinary Companion / Elite Concierge).
-- service-booking holds its own copy because cross-service joins are
-- barred (CLAUDE.md §2.3); the row is the cache, the gating logic
-- consults this row alongside the household snapshot.
CREATE TABLE "booking"."provider_tier_snapshots" (
    "provider_id" TEXT NOT NULL,
    "tier" "booking"."provider_tier_snapshot_tier" NOT NULL,
    "last_synced_at" TIMESTAMPTZ(6) NOT NULL,
    "source_event_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_tier_snapshots_pkey" PRIMARY KEY ("provider_id")
);
