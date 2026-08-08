-- TS-110 — initial media schema.
--
-- Creates the `media` Postgres schema, five enums, the two core tables
-- (media_assets + media_asset_events), supporting indexes, and the
-- defence-in-depth triggers.
--
-- Reversal plan:
--   DROP TRIGGER "media_asset_events_no_update"  ON "media"."media_asset_events";
--   DROP TRIGGER "media_asset_events_no_delete"  ON "media"."media_asset_events";
--   DROP FUNCTION "media"."media_asset_events_no_update_or_delete"();
--   DROP TABLE    "media"."media_asset_events";
--   DROP TRIGGER  "media_assets_no_rebind"       ON "media"."media_assets";
--   DROP FUNCTION "media"."media_assets_no_rebind"();
--   DROP TABLE    "media"."media_assets";
--   DROP TYPE     "media"."media_asset_event_kind";
--   DROP TYPE     "media"."media_owner_scope_kind";
--   DROP TYPE     "media"."media_scan_status";
--   DROP TYPE     "media"."media_asset_status";
--   DROP TYPE     "media"."media_asset_kind";
--   DROP SCHEMA   "media";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).
--
-- Forward-compatible: subsequent migrations add (never repurpose) per
-- CLAUDE.md §4.1.

CREATE SCHEMA IF NOT EXISTS "media";

-- ─── Enums ──────────────────────────────────────────────────────────────

CREATE TYPE "media"."media_asset_kind" AS ENUM (
  'senior_photo',
  'provider_profile_photo',
  'provider_video_intro',
  'memory_recipe_image',
  'provider_document',
  'certification_evidence',
  'academy_lesson_attachment'
);

CREATE TYPE "media"."media_asset_status" AS ENUM (
  'awaiting_upload',
  'uploaded',
  'scanning',
  'ready',
  'rejected',
  'failed',
  'expired'
);

CREATE TYPE "media"."media_scan_status" AS ENUM (
  'pending',
  'clean',
  'infected',
  'failed'
);

CREATE TYPE "media"."media_owner_scope_kind" AS ENUM (
  'user',
  'household',
  'senior',
  'provider',
  'course'
);

CREATE TYPE "media"."media_asset_event_kind" AS ENUM (
  'upload_completed',
  'magic_byte_passed',
  'magic_byte_failed',
  'scan_passed',
  'scan_failed',
  'process_passed',
  'process_failed',
  'expired'
);

-- ─── media_assets ──────────────────────────────────────────────────────
--
-- One row per declared upload intent. See the Prisma model doc-comment
-- for the full state machine and the soft-FK / append-only discipline.

CREATE TABLE "media"."media_assets" (
  "id"                          TEXT                                NOT NULL,
  "owner_user_id"               TEXT                                NOT NULL,
  "owner_scope_kind"            "media"."media_owner_scope_kind"    NOT NULL,
  "owner_scope_id"              TEXT                                NOT NULL,
  "kind"                        "media"."media_asset_kind"          NOT NULL,
  "status"                      "media"."media_asset_status"        NOT NULL DEFAULT 'awaiting_upload',
  "scan_status"                 "media"."media_scan_status"         NOT NULL DEFAULT 'pending',
  "scan_reason"                 TEXT,
  "declared_mime"               TEXT                                NOT NULL,
  "detected_mime"               TEXT,
  "declared_file_name"          TEXT,
  "declared_size_bytes"         BIGINT                              NOT NULL,
  "actual_size_bytes"           BIGINT,
  "width"                       INTEGER,
  "height"                      INTEGER,
  "sha256"                      TEXT,
  "storage_bucket"              TEXT                                NOT NULL,
  "storage_key"                 TEXT                                NOT NULL,
  "delivery_key"                TEXT,
  "live_mode"                   BOOLEAN                             NOT NULL DEFAULT FALSE,
  "upload_url_expires_at"       TIMESTAMPTZ(6)                      NOT NULL,
  "uploaded_at"                 TIMESTAMPTZ(6),
  "scanned_at"                  TIMESTAMPTZ(6),
  "processed_at"                TIMESTAMPTZ(6),
  "created_at"                  TIMESTAMPTZ(6)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMPTZ(6)                      NOT NULL,

  CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id"),

  -- Defence-in-depth invariants (CLAUDE.md §3.4):
  --   declared / actual sizes positive — a zero or negative declared
  --     size is a malformed request that bypasses the cap; reject at DB.
  CONSTRAINT "media_assets_declared_size_positive"
    CHECK ("declared_size_bytes" > 0),
  CONSTRAINT "media_assets_actual_size_positive"
    CHECK ("actual_size_bytes" IS NULL OR "actual_size_bytes" > 0),
  --   dimensions positive when populated.
  CONSTRAINT "media_assets_width_positive"
    CHECK ("width" IS NULL OR "width" > 0),
  CONSTRAINT "media_assets_height_positive"
    CHECK ("height" IS NULL OR "height" > 0),
  --   sha256 is 64 lower-case hex chars when populated.
  CONSTRAINT "media_assets_sha256_hex"
    CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
);

-- Powers the "list assets in this scope" read path — primary surface
-- for the family / provider portal.
CREATE INDEX "media_assets_scope_created_idx"
  ON "media"."media_assets" ("owner_scope_kind", "owner_scope_id", "created_at" DESC);

-- Powers the admin "stuck / pending" filter
-- (status=awaiting_upload older than N minutes; status=scanning older
-- than N minutes).
CREATE INDEX "media_assets_status_created_idx"
  ON "media"."media_assets" ("status", "created_at" DESC);

-- Powers the admin "all my assets" filter for a single user.
CREATE INDEX "media_assets_owner_user_created_idx"
  ON "media"."media_assets" ("owner_user_id", "created_at" DESC);

-- UNIQUE on (storage_bucket, storage_key) — S3 keys are deterministically
-- derived from `(env, kind, year, month, asset id)` and a collision
-- would corrupt the audit trail.
CREATE UNIQUE INDEX "media_assets_storage_unique_idx"
  ON "media"."media_assets" ("storage_bucket", "storage_key");

-- Defence-in-depth against a regression that rebinds an asset row to a
-- different owner / scope / kind / storage location (which would
-- corrupt every downstream consumer of the audit trail). The trigger
-- raises on any UPDATE that changes any of these columns. Service-layer
-- code never UPDATEs them; admin tooling that needs to remap must
-- DROP TRIGGER + apply the change + recreate.
CREATE OR REPLACE FUNCTION "media"."media_assets_no_rebind"()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."owner_user_id"     IS DISTINCT FROM OLD."owner_user_id"
  OR NEW."owner_scope_kind"  IS DISTINCT FROM OLD."owner_scope_kind"
  OR NEW."owner_scope_id"    IS DISTINCT FROM OLD."owner_scope_id"
  OR NEW."kind"              IS DISTINCT FROM OLD."kind"
  OR NEW."storage_bucket"    IS DISTINCT FROM OLD."storage_bucket"
  OR NEW."storage_key"       IS DISTINCT FROM OLD."storage_key"
  THEN
    RAISE EXCEPTION
      'media_assets: owner_user_id / owner_scope_kind / owner_scope_id / kind / storage_bucket / storage_key are immutable after create (TS-110; CLAUDE.md §3.4)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "media_assets_no_rebind"
  BEFORE UPDATE ON "media"."media_assets"
  FOR EACH ROW EXECUTE FUNCTION "media"."media_assets_no_rebind"();

-- ─── media_asset_events ───────────────────────────────────────────────
--
-- Append-only audit trail of every state transition on a media asset.

CREATE TABLE "media"."media_asset_events" (
  "id"                          TEXT                                  NOT NULL,
  "asset_id"                    TEXT                                  NOT NULL,
  "event_kind"                  "media"."media_asset_event_kind"      NOT NULL,
  "occurred_at"                 TIMESTAMPTZ(6)                        NOT NULL,
  "detected_mime"               TEXT,
  "sha256"                      TEXT,
  "size_bytes"                  BIGINT,
  "width"                       INTEGER,
  "height"                      INTEGER,
  "delivery_key"                TEXT,
  "reason"                      TEXT,
  "created_at"                  TIMESTAMPTZ(6)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_asset_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_asset_events_asset_id_fkey"
    FOREIGN KEY ("asset_id")
    REFERENCES "media"."media_assets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  -- Same defence-in-depth as media_assets.
  CONSTRAINT "media_asset_events_size_positive"
    CHECK ("size_bytes" IS NULL OR "size_bytes" > 0),
  CONSTRAINT "media_asset_events_width_positive"
    CHECK ("width" IS NULL OR "width" > 0),
  CONSTRAINT "media_asset_events_height_positive"
    CHECK ("height" IS NULL OR "height" > 0),
  CONSTRAINT "media_asset_events_sha256_hex"
    CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
);

-- Powers the "events for this asset" admin read.
CREATE INDEX "media_asset_events_asset_occurred_idx"
  ON "media"."media_asset_events" ("asset_id", "occurred_at" DESC);

-- UNIQUE on (asset_id, event_kind) — idempotent replay semantics. The
-- media-processor MAY re-emit a given stage event (e.g. on retry); the
-- second insert hits this constraint and the service reports
-- `outcome=replayed`.
CREATE UNIQUE INDEX "media_asset_events_asset_kind_unique_idx"
  ON "media"."media_asset_events" ("asset_id", "event_kind");

-- Append-only enforcement at the DB layer. CLAUDE.md §3.6 mandates
-- append-only audit logs across the platform; while these events are
-- not the "admin audit log" themselves, they sit on the same audit
-- substrate and benefit from the same guarantee. Service-layer code
-- only INSERTs; an admin tooling regression that tries to UPDATE / DELETE
-- a row is caught here.
CREATE OR REPLACE FUNCTION "media"."media_asset_events_no_update_or_delete"()
  RETURNS TRIGGER
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'media_asset_events is append-only — UPDATE rejected (TS-110; CLAUDE.md §3.6)';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'media_asset_events is append-only — DELETE rejected (TS-110; CLAUDE.md §3.6)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "media_asset_events_no_update"
  BEFORE UPDATE ON "media"."media_asset_events"
  FOR EACH ROW EXECUTE FUNCTION "media"."media_asset_events_no_update_or_delete"();

CREATE TRIGGER "media_asset_events_no_delete"
  BEFORE DELETE ON "media"."media_asset_events"
  FOR EACH ROW EXECUTE FUNCTION "media"."media_asset_events_no_update_or_delete"();
