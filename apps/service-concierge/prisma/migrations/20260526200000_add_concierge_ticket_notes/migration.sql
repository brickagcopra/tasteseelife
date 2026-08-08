-- TS-224 — concierge ops console: internal-notes timeline.
--
-- Adds the `concierge.concierge_ticket_notes` table — the append-only
-- internal-notes log ops staff write while working a ticket on the console
-- (PDD §10.6 "Internal notes and follow-ups"). One ticket has many notes;
-- notes are never edited or deleted (an internal audit trail of ops
-- activity, in the spirit of CLAUDE.md §3.6).
--
-- Forward-compatible expand-only migration (CLAUDE.md §4.1) — a brand-new
-- table, so there is nothing to backfill and no existing-row risk.
--
-- Foreign key: `ticket_id` references `concierge.concierge_tickets(id)` —
-- an IN-SERVICE relation (both tables live in the `concierge` schema), which
-- CLAUDE.md §4.1 allows (it forbids FKs only ACROSS service schemas).
-- ON DELETE CASCADE keeps the timeline consistent if a ticket is ever
-- hard-deleted (today tickets are soft-deleted only — defence-in-depth).
--
-- `household_id` is denormalised from the parent ticket — it is the
-- tenant-scope key the TS-141 Prisma extension filters on (every model in
-- this service carries the household axis), and it gives an "all notes for
-- this household" read axis. `author_user_id` is a soft FK into
-- `identity.users.id` (the authoring ops staff member) — by id only, no
-- cross-service relation (CLAUDE.md §2.3).
--
-- Reversal plan (drop indexes + FK first, then the table):
--   DROP INDEX IF EXISTS "concierge"."concierge_ticket_notes_household_id_idx";
--   DROP INDEX IF EXISTS "concierge"."concierge_ticket_notes_ticket_created_idx";
--   ALTER TABLE "concierge"."concierge_ticket_notes"
--     DROP CONSTRAINT IF EXISTS "concierge_ticket_notes_ticket_id_fkey";
--   DROP TABLE IF EXISTS "concierge"."concierge_ticket_notes";
-- Safe in isolation — no other service schema references these objects.
--
-- Migration authored by hand to match prisma/schema.prisma. Apply with:
--   pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy

-- CreateTable
CREATE TABLE "concierge"."concierge_ticket_notes" (
  "id"             TEXT NOT NULL,
  "ticket_id"      TEXT NOT NULL,
  "household_id"   TEXT NOT NULL,
  "author_user_id" TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "concierge_ticket_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Powers the ticket-detail notes timeline (TS-224): "this ticket's notes
-- oldest-first". Composite so a single index scan filters by ticket AND
-- returns rows in created_at order without a separate sort.
CREATE INDEX "concierge_ticket_notes_ticket_created_idx"
  ON "concierge"."concierge_ticket_notes"("ticket_id", "created_at");

-- CreateIndex
-- Tenant-scope filter + "all notes for this household" reads.
CREATE INDEX "concierge_ticket_notes_household_id_idx"
  ON "concierge"."concierge_ticket_notes"("household_id");

-- AddForeignKey
-- In-service FK to the parent ticket (CLAUDE.md §4.1 — allowed within a
-- single service schema). CASCADE on delete keeps the notes timeline
-- consistent with its ticket.
ALTER TABLE "concierge"."concierge_ticket_notes"
  ADD CONSTRAINT "concierge_ticket_notes_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "concierge"."concierge_tickets"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
