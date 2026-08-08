-- TS-206 — Provider external calendar sync (Google Calendar free/busy).
--
-- Adds two enums (`provider_calendar_provider`,
-- `provider_calendar_connection_status`), two tables
-- (`provider_calendar_connections`, `provider_availability_external`),
-- and two indexes. The schema backs the OAuth connect / sync /
-- disconnect surface (`POST /api/v1/providers/:providerId/calendar/
-- google/connect`, `POST .../calendar/sync`, `DELETE .../calendar/
-- google`) and the availability-union projection: the busy intervals
-- mirrored into `provider_availability_external` subtract from the
-- recurring windows (TS-203) the discovery snapshot projects.
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1):
--
--   - Both enums are created fresh; no existing types reference them.
--
--   - `provider_calendar_connections` is a brand-new table — no
--     existing reads/writes touch it. The TS-206 `CalendarSyncService`
--     is the first (and only) writer. The Google refresh token is held
--     AES-256-GCM-encrypted in the four `refresh_token_*` columns
--     (ciphertext + 96-bit IV + 128-bit GCM tag + key version),
--     mirroring the `provider_background_checks.payload_*` shape, under
--     an INDEPENDENT cipher key (CLAUDE.md §3.5).
--
--   - `provider_availability_external` is also new — a read-only,
--     re-buildable mirror of busy intervals. It carries NO event
--     content (only opaque absolute `[starts_at, ends_at)` UTC instants
--     + the source), so dropping + re-syncing is always safe.
--
-- No data migration step needed — both tables start empty and the new
-- enums are created standalone. Providers populate the first rows as
-- they link their external calendars via the connect flow.
--
-- Reversal plan (drop in reverse-creation order):
--
--   DROP INDEX IF EXISTS "provider"."provider_availability_external_provider_starts_idx";
--   DROP TABLE          "provider"."provider_availability_external";
--   DROP INDEX IF EXISTS "provider"."provider_calendar_connections_provider_id_key";
--   DROP TABLE          "provider"."provider_calendar_connections";
--   DROP TYPE           "provider"."provider_calendar_connection_status";
--   DROP TYPE           "provider"."provider_calendar_provider";
--
-- Safe in isolation — the new tables have no inbound FKs so they drop
-- cleanly. A rollback removes the TS-206 surface but leaves every
-- existing provider row intact. Dropping the connections table destroys
-- the encrypted refresh tokens; providers re-consent on the next link.

-- CreateEnum: provider_calendar_provider ----------------------------------
--
-- Phase-1 ships `google` only. `icloud` / `outlook` append (never
-- reorder) with TS-206-followup-2 via `ALTER TYPE … ADD VALUE`.
CREATE TYPE "provider"."provider_calendar_provider" AS ENUM (
    'google'
);

-- CreateEnum: provider_calendar_connection_status -------------------------
--
-- `connected` = healthy; `error` = last free/busy pull failed (refresh
-- token rejected — provider revoked access or grant expired). A
-- disconnected provider has no row at all, so there is no
-- `disconnected` member.
CREATE TYPE "provider"."provider_calendar_connection_status" AS ENUM (
    'connected',
    'error'
);

-- CreateTable: provider_calendar_connections ------------------------------
--
-- One row per (provider, external calendar). Phase-1 one Google
-- connection per provider — the `provider_id` UNIQUE index enforces it.
-- The `calendar_provider` column is forward-compat for the iCloud /
-- Outlook siblings; when a provider can link more than one external
-- calendar, the unique moves to `(provider_id, calendar_provider)`.
--
-- The Google refresh token (a long-lived secret) is stored AES-256-GCM-
-- encrypted under an INDEPENDENT key (`CALENDAR_TOKEN_ENC_KEY`,
-- CLAUDE.md §3.5). `connected_account_email` is low-sensitivity (the
-- provider's own account address) and stored in clear for display.
CREATE TABLE "provider"."provider_calendar_connections" (
    "id"                        TEXT                                                NOT NULL,
    "provider_id"               TEXT                                                NOT NULL,
    "calendar_provider"         "provider"."provider_calendar_provider"             NOT NULL DEFAULT 'google',
    "status"                    "provider"."provider_calendar_connection_status"    NOT NULL DEFAULT 'connected',
    "connected_account_email"   TEXT,
    "granted_scope"             TEXT,
    "refresh_token_ciphertext"  BYTEA                                               NOT NULL,
    "refresh_token_iv"          BYTEA                                               NOT NULL,
    "refresh_token_auth_tag"    BYTEA                                               NOT NULL,
    "refresh_token_key_version" INTEGER                                             NOT NULL,
    "last_synced_at"            TIMESTAMPTZ(6),
    "last_sync_error"           TEXT,
    "created_at"                TIMESTAMPTZ(6)                                       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMPTZ(6)                                       NOT NULL,

    CONSTRAINT "provider_calendar_connections_pkey" PRIMARY KEY ("id")
);

-- One connection per provider (Phase-1). The UNIQUE index also serves
-- the dominant read path `getConnection(providerId)` /
-- `getConnectionByUserId` (which resolves the provider id first).
--
-- EXPLAIN: `SELECT … FROM provider_calendar_connections WHERE
-- provider_id = $1` is an index-only lookup on the unique index.
CREATE UNIQUE INDEX "provider_calendar_connections_provider_id_key"
    ON "provider"."provider_calendar_connections"("provider_id");

-- CreateTable: provider_availability_external -----------------------------
--
-- Read-only busy mirror. One row per external busy interval pulled from
-- the free/busy API. Re-buildable: a sync DELETEs every row for the
-- provider then bulk-inserts the fresh set inside one transaction.
--
-- Absolute UTC instants (`timestamptz`) — unlike the recurring
-- `provider_availability_windows` (local-wall-clock `time(0)`). The
-- availability-union helper converts the local recurring windows into
-- UTC instants (using `providers.time_zone`) before testing overlap.
--
-- NO event content — only opaque `[starts_at, ends_at)` + the source.
CREATE TABLE "provider"."provider_availability_external" (
    "id"          TEXT                                    NOT NULL,
    "provider_id" TEXT                                    NOT NULL,
    "source"      "provider"."provider_calendar_provider" NOT NULL DEFAULT 'google',
    "starts_at"   TIMESTAMPTZ(6)                          NOT NULL,
    "ends_at"     TIMESTAMPTZ(6)                          NOT NULL,
    "synced_at"   TIMESTAMPTZ(6)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"  TIMESTAMPTZ(6)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_availability_external_pkey" PRIMARY KEY ("id")
);

-- Powers the dominant read path —
-- `getExternalBusyIntervals(providerId)` returns the provider's
-- mirrored intervals ordered by start. The `(provider_id, starts_at)`
-- shape also serves a future booking-svc availability gate's "is this
-- provider busy at instant T?" range scan (TS-206-followup-4).
--
-- EXPLAIN: `SELECT starts_at, ends_at FROM provider_availability_external
-- WHERE provider_id = $1 ORDER BY starts_at` uses this index.
CREATE INDEX "provider_availability_external_provider_starts_idx"
    ON "provider"."provider_availability_external"("provider_id", "starts_at");
