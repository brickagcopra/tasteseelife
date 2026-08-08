-- TS-301a — the filer's free-text report on `incidents`.
--
-- Expand-only (CLAUDE.md §4.1): adds a nullable `description` column carrying
-- the report text a family/senior filer typed on the "Report a concern"
-- surface. Nullable because system-sourced incidents (TS-302 event ingestion)
-- carry no free text. Bounded at the contract boundary
-- (TRUST_SAFETY_REPORT_DESCRIPTION_MAX_LENGTH = 4000) — TEXT here, not
-- VARCHAR, per the repo convention (the bound is a DTO concern; the column
-- doesn't fight resizes).
--
-- No index: the description is never a predicate — it is read only as part of
-- the incident detail row by authorised ops surfaces. PII/PHI discipline: the
-- column never rides outbox events or logs (CLAUDE.md §3.9, §10).
--
-- Reversal plan:
--   ALTER TABLE "trust_safety"."incidents" DROP COLUMN "description";

ALTER TABLE "trust_safety"."incidents" ADD COLUMN "description" TEXT;
