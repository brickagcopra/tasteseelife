-- TS-060-followup-2 — service_catalog table (PRD §5.4 / §6.3; PDD §8.2).
--
-- The admin-editable pricing / duration metadata layer that sits beside
-- the `service_kind` enum + `bookings.service_kind` column shipped by
-- TS-060. One row per `service_kind` (the `kind` column is UNIQUE — the
-- admin upsert keys on it). Money columns are `DECIMAL(12,2)` + an
-- explicit `CHAR(3)` currency per CLAUDE.md §4.1 (never floats).
--
-- Forward-compatible additive migration (expand → migrate → contract,
-- CLAUDE.md §4.1): a new table, no change to existing rows. The catalog
-- is populated idempotently out-of-band by `pnpm seed:catalog`
-- (`src/modules/catalog/seed.ts`), not in this migration, so a reseed
-- after an operator edit only refreshes the mutable columns.
--
-- Reversal plan (safe in isolation — no other service schema or table
-- references this object):
--   DROP TABLE "booking"."service_catalog";

CREATE TABLE "booking"."service_catalog" (
    "id" TEXT NOT NULL,
    "kind" "booking"."service_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "base_rate_min" DECIMAL(12,2) NOT NULL,
    "base_rate_max" DECIMAL(12,2) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_position" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_catalog_pkey" PRIMARY KEY ("id")
);

-- One catalog row per service kind — the upsert key.
CREATE UNIQUE INDEX "service_catalog_kind_key" ON "booking"."service_catalog"("kind");

-- Powers `GET /api/v1/service-catalog` ("list the active catalog in
-- sort order"). EXPLAIN: an index range scan on (active, sort_position)
-- serves the dominant read without a sort node. The catalog is tiny
-- (seven rows) so the win is marginal today; the index pays off when
-- retired (active = false) kinds accumulate and the active subset stays
-- selective.
CREATE INDEX "service_catalog_active_sort_idx" ON "booking"."service_catalog"("active", "sort_position");
