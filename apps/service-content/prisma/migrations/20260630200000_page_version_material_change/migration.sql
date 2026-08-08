-- TS-285 — material-change notification on legal page edits: the
-- `is_material_change` flag + `material_change_note` on `content.page_versions`
-- (PDD §19.2; PRD §10.11).
--
-- Forward-only expand migration. Adds a NOT NULL boolean with a `false` default
-- (so pre-existing rows — none in a greenfield deploy — read as non-material)
-- plus a NULLABLE note column. No backfill, no mutations to existing rows, no
-- destructive DDL — additive, zero-downtime (expand → migrate → contract,
-- CLAUDE.md §4.1). No index: `is_material_change` is not a where-predicate at
-- scale (a material publish is a rare event that fans out via the outbox, not a
-- filtered read path).
--
-- When an editor publishes a version flagged material, `PagesService.publishVersion`
-- persists these two columns AND appends a `content.page.material_changed` event
-- to `content.outbox_events` inside the same publish transaction (the outbox
-- invariant — CLAUDE.md §5.3). The `worker-outbox-relay` (already draining
-- `content.outbox_events` — TS-284) forwards it; the `service-notification`
-- consumer (TS-285-followup-1) fans out the email + in-app banner.
--
-- Reversal plan:
--   ALTER TABLE "content"."page_versions" DROP COLUMN IF EXISTS "material_change_note";
--   ALTER TABLE "content"."page_versions" DROP COLUMN IF EXISTS "is_material_change";
-- Safe in isolation — additive columns, no FK / no dependent view.
--
-- Apply with:
--   pnpm -F @taste-and-see/service-content prisma:migrate:deploy

-- AlterTable: add the material-change flag (NOT NULL, default false) + note.
ALTER TABLE "content"."page_versions"
    ADD COLUMN "is_material_change" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "material_change_note" TEXT;
