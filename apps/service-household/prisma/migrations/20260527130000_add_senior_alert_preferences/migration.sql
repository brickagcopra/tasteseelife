-- TS-234 — per-(senior × family-member) alert subscriptions
-- (PRD §6.4 "Alert configurations"; PDD §12.3; CLAUDE.md §3, §4.1).
--
-- Forward-only expand migration. One additive shape change:
--
--   NEW TABLE `household.senior_alert_preferences` — one row per
--   (senior × member) carrying three alert-type booleans. Each household
--   member (the primary payer AND every family observer) subscribes
--   themselves to the alerts they want about a senior:
--     * `missed_visit`           — a booked visit the provider did not
--                                  show up for. Default ON.
--     * `concerning_observation` — a concerning wellness-observation
--                                  pattern (the TS-236 detector). Observer
--                                  delivery is gated at emission time by
--                                  the senior's `notes` consent (TS-238).
--                                  Default OFF (opt-in).
--     * `emergency_flag`         — a welfare / emergency flag raised
--                                  during a visit or by trust & safety.
--                                  Default ON.
--
--   Defaults differ from the TS-238 consent map (which is all-opt-out):
--   operational + safety alerts a paying family wants without opting in
--   default ON; the observation-derived alert defaults OFF. The service
--   synthesises the all-default shape when no row exists (the row is
--   created lazily on the first `PUT`), and the column defaults match so
--   a first write equal to the synthesised state is row-shape-stable.
--
--   Distinct from `senior_consent` (1:1 per senior, manager-set). This
--   table is per-(senior × member): the composite PRIMARY KEY is
--   `(senior_id, user_id)`. `user_id` is a soft FK into
--   `identity.users.id` (no Prisma relation, no DB-level FK across the
--   service boundary — CLAUDE.md §2.3 / §4.1). `senior_id` is an
--   in-service FK to `seniors(id)` ON DELETE CASCADE so a senior delete
--   tombstones every member's subscription.
--
--   Index rationale. The composite PK `(senior_id, user_id)` serves the
--   dominant read — a member loading their own subscription for a senior
--   (point lookup). A standalone `senior_id` index
--   (`senior_alert_preferences_senior_id_idx`) serves the future
--   alert-dispatch fan-out ("every member subscribed to this senior")
--   that the deferred detector workers (TS-235 / TS-236) will run.
--   No `user_id`-only index — there is no "every senior this member
--   subscribes to" read path today.
--
-- Non-blocking against existing rows (brand-new table).
--
-- Reversal plan (forward-compatible — execute in reverse order):
--   DROP INDEX  "household"."senior_alert_preferences_senior_id_idx";
--   ALTER TABLE "household"."senior_alert_preferences" DROP CONSTRAINT "senior_alert_preferences_senior_id_fkey";
--   DROP TABLE  "household"."senior_alert_preferences";
-- Safe in isolation — no other service references this table
-- (cross-service relations are by id only — CLAUDE.md §2.3).
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-household prisma:migrate:deploy

-- CreateTable — per-(senior × member) alert subscriptions
CREATE TABLE "household"."senior_alert_preferences" (
  "senior_id"              TEXT           NOT NULL,
  "user_id"                TEXT           NOT NULL,
  "missed_visit"           BOOLEAN        NOT NULL DEFAULT true,
  "concerning_observation" BOOLEAN        NOT NULL DEFAULT false,
  "emergency_flag"         BOOLEAN        NOT NULL DEFAULT true,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"             TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "senior_alert_preferences_pkey" PRIMARY KEY ("senior_id", "user_id")
);

-- CreateIndex — alert-dispatch fan-out per senior (TS-235 / TS-236)
CREATE INDEX "senior_alert_preferences_senior_id_idx"
  ON "household"."senior_alert_preferences" ("senior_id");

-- AddForeignKey
ALTER TABLE "household"."senior_alert_preferences"
  ADD CONSTRAINT "senior_alert_preferences_senior_id_fkey"
  FOREIGN KEY ("senior_id") REFERENCES "household"."seniors"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
