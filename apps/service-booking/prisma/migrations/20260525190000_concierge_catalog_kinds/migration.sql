-- TS-220 — Tier-3 concierge service kinds + catalog required-provider-tier
-- (PRD §6.6; PDD §8.2; CLAUDE.md §12).
--
-- Three additive changes (expand → migrate → contract, CLAUDE.md §4.1):
--
--  1. Six new values on the `booking.service_kind` enum — the Tier-3
--     concierge experiences (PRD §6.6). Appended, never reordered, so
--     existing rows + persisted ordinals are untouched.
--  2. A new `booking.provider_tier` enum (basic / certified / elite),
--     mirroring the contract `ProviderTierSchema`.
--  3. A new nullable `required_provider_tier` column on
--     `booking.service_catalog`. NULL = any tier (existing rows keep
--     the basic-marketplace default); the Tier-3 kinds are seeded with
--     `elite` out-of-band by `pnpm seed:catalog`.
--
-- PG 12+ allows `ALTER TYPE ... ADD VALUE` inside Prisma's per-migration
-- implicit transaction; the new values are NOT used within this migration
-- (seeding is out-of-band), so the "cannot use a new enum value in the
-- same transaction" restriction does not apply. `ADD VALUE IF NOT EXISTS`
-- keeps the migration rerunnable (same convention as the TS-205
-- `booking_status` enum extension). The new `provider_tier` type is
-- created and referenced in the same transaction, which is permitted for
-- a freshly-created enum.
--
-- Reversal plan:
--   ALTER TABLE "booking"."service_catalog" DROP COLUMN "required_provider_tier";
--   DROP TYPE "booking"."provider_tier";
--   -- The six `service_kind` values cannot be dropped in place (Postgres
--   -- has no `ALTER TYPE ... DROP VALUE`). A true rollback recreates the
--   -- enum without them via the same `*_old` rename dance documented in
--   -- the TS-205 migration; safe only while no row references a new value
--   -- (none do until a Tier-3 booking lands). This is the standard
--   -- additive-enum caveat shared by every enum migration in this repo.

-- 1. Tier-3 concierge service kinds (PRD §6.6).
ALTER TYPE "booking"."service_kind" ADD VALUE IF NOT EXISTS 'holiday_dinner';
ALTER TYPE "booking"."service_kind" ADD VALUE IF NOT EXISTS 'birthday_experience';
ALTER TYPE "booking"."service_kind" ADD VALUE IF NOT EXISTS 'tea_social';
ALTER TYPE "booking"."service_kind" ADD VALUE IF NOT EXISTS 'museum_outing';
ALTER TYPE "booking"."service_kind" ADD VALUE IF NOT EXISTS 'memory_meal';
ALTER TYPE "booking"."service_kind" ADD VALUE IF NOT EXISTS 'custom_request';

-- 2. Provider-tier enum (mirrors the contract ProviderTierSchema).
CREATE TYPE "booking"."provider_tier" AS ENUM ('basic', 'certified', 'elite');

-- 3. Catalog required-provider-tier column — nullable, no default
--    (NULL = any tier). No backfill: existing basic-marketplace rows
--    stay NULL; the seed sets `elite` on the Tier-3 kinds. Not indexed —
--    `required_provider_tier` is never a WHERE predicate (the catalog is
--    tiny and read whole).
ALTER TABLE "booking"."service_catalog" ADD COLUMN "required_provider_tier" "booking"."provider_tier";
