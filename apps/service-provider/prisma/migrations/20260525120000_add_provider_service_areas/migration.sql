-- TS-202 — Provider service areas (declared coverage polygons).
--
-- Adds one table (`provider_service_areas`) and one index. The schema
-- backs the self-service editor surface
-- (`PUT /api/v1/providers/:providerId/service-areas`) the web-provider
-- portal calls (TS-202), and the discovery-snapshot projection that the
-- search-indexer (TS-053-followup-3) reads for the
-- `ProviderDiscoveryDocument.centroid` field.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1):
--
--   - `provider_service_areas` is a brand-new table — no existing
--     reads/writes touch it. The TS-202 service-provider
--     `ServiceAreasService` is the first writer; the discovery-snapshot
--     projection (TS-053-followup-3) + the booking-svc
--     household-in-service-area gate (TS-210) are the first readers.
--
-- No data migration step needed — the table starts empty. The
-- web-provider editor (TS-202) writes the first rows as providers
-- declare their coverage.
--
-- Reversal plan (drop in reverse-creation order):
--
--   DROP INDEX IF EXISTS "provider"."provider_service_areas_provider_idx";
--   DROP TABLE          "provider"."provider_service_areas";
--
-- Safe in isolation — the new table has no inbound FKs so it drops
-- cleanly. A rollback removes the TS-202 surface but leaves every
-- existing provider row intact.

-- CreateTable: provider_service_areas -------------------------------------
--
-- One row per declared coverage polygon. The provider declares "I cover
-- the Upper East Side" by inserting one row whose `geo_polygon` is a
-- GeoJSON Polygon (RFC 7946) — `coordinates[0]` is the exterior ring,
-- subsequent rings are holes, positions are `[longitude, latitude]`.
--
-- `geo_polygon` is `jsonb` (not PostGIS `geometry`) — the Phase-1
-- self-managed Postgres ships no PostGIS extension. The centroid +
-- bounding box are NOT derived in SQL; `ServiceAreasService` computes
-- the planar area-weighted centroid + axis-aligned bbox in application
-- code at write time and persists them in the `double precision`
-- columns below. The search-indexer (TS-053-followup-3) reads the
-- centroid for the discovery-doc; polygon-intersection scoring lands
-- with the live Elasticsearch geo wiring (TS-210).
--
-- The `centroid_*` / `bbox_*` columns hold WGS84 decimal degrees. These
-- are geographic coordinates, NOT money — `double precision` is the
-- conventional representation and the CLAUDE.md §4.1 "no floats for
-- money" rule does not apply.
CREATE TABLE "provider"."provider_service_areas" (
    "id"                 TEXT             NOT NULL,
    "provider_id"        TEXT             NOT NULL,
    "label"              TEXT,
    "geo_polygon"        JSONB            NOT NULL,
    "centroid_latitude"  DOUBLE PRECISION NOT NULL,
    "centroid_longitude" DOUBLE PRECISION NOT NULL,
    "bbox_min_latitude"  DOUBLE PRECISION NOT NULL,
    "bbox_min_longitude" DOUBLE PRECISION NOT NULL,
    "bbox_max_latitude"  DOUBLE PRECISION NOT NULL,
    "bbox_max_longitude" DOUBLE PRECISION NOT NULL,
    "created_at"         TIMESTAMPTZ(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMPTZ(6)   NOT NULL,

    CONSTRAINT "provider_service_areas_pkey" PRIMARY KEY ("id")
);

-- Powers the dominant read path —
-- `ServiceAreasService.getServiceAreas(providerId)` returns the full
-- set of coverage polygons for one provider, sorted client-side. The
-- discovery-snapshot projection (TS-053-followup-3) reads the same way.
--
-- EXPLAIN: `SELECT id, label, geo_polygon, centroid_latitude, ... FROM
-- provider_service_areas WHERE provider_id = $1` uses this index for an
-- index scan on `provider_id` (the row count per provider is tiny —
-- capped at 10 by the contract layer — so a heap fetch for the polygon
-- payload is cheap).
CREATE INDEX "provider_service_areas_provider_idx"
    ON "provider"."provider_service_areas"("provider_id");
