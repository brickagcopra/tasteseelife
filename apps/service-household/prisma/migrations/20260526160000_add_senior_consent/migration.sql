-- TS-238 — senior family-observability consent map
-- (PRD §6.4, §6.5; PDD §8.2; CLAUDE.md §12, §3, §4.1).
--
-- Forward-only expand migration. One additive shape change:
--
--   NEW TABLE `household.senior_consent` — one row per senior carrying
--   four surface-visibility booleans that gate what a `family_observer`
--   household member may see:
--     * `photos`   — visit photo summaries + memory-recipe images
--                    (media-svc; consumed by TS-232 / TS-110-followup-10 /
--                    TS-062-followup-3 once those land).
--     * `notes`    — wellness observation notes (service-booking; consumed
--                    by a TS-238 follow-up + TS-233).
--     * `location` — geo check-in coordinates (service-booking; consumed
--                    by a TS-238 follow-up).
--     * `health`   — the senior's health/medical profile (DOB, dementia
--                    stage, encrypted intake notes — service-household).
--                    This is the surface TS-238 gates LIVE: the intake
--                    read now returns 403 to a family observer unless
--                    `health` consent is granted.
--
--   Every flag defaults to `false` — CLAUDE.md §12 "the default is
--   opt-out". A senior with no row shares nothing; the service returns
--   the all-`false` shape when the row is absent (the row is created
--   lazily on the first `PUT`). `updated_by_user_id` is a soft FK into
--   `identity.users.id` (no Prisma relation, no DB-level FK across the
--   service boundary — CLAUDE.md §2.3 / §4.1), null until first set.
--
--   1:1 with `seniors` — the PRIMARY KEY is `senior_id` itself, so no
--   secondary index is needed (every read is a PK point-lookup). The
--   in-service FK to `seniors(id)` ON DELETE CASCADE tombstones consent
--   with the senior. No backfill — the table starts empty and absence
--   means opt-out.
--
-- Non-blocking against existing rows (brand-new table).
--
-- Reversal plan (forward-compatible — execute in reverse order):
--   ALTER TABLE "household"."senior_consent" DROP CONSTRAINT "senior_consent_senior_id_fkey";
--   DROP TABLE  "household"."senior_consent";
-- Safe in isolation — no other service references this table
-- (cross-service relations are by id only — CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-household prisma:migrate:deploy

-- CreateTable — per-senior family-observability consent
CREATE TABLE "household"."senior_consent" (
  "senior_id"          TEXT           NOT NULL,
  "photos"             BOOLEAN        NOT NULL DEFAULT false,
  "notes"              BOOLEAN        NOT NULL DEFAULT false,
  "location"           BOOLEAN        NOT NULL DEFAULT false,
  "health"             BOOLEAN        NOT NULL DEFAULT false,
  "updated_by_user_id" TEXT,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "senior_consent_pkey" PRIMARY KEY ("senior_id")
);

-- AddForeignKey
ALTER TABLE "household"."senior_consent"
  ADD CONSTRAINT "senior_consent_senior_id_fkey"
  FOREIGN KEY ("senior_id") REFERENCES "household"."seniors"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
