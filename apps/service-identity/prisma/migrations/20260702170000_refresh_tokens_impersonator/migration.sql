-- TS-297 — admin impersonation sessions (PRD §10.2; CLAUDE.md §3.6).
--
-- Impersonation sessions are ordinary refresh-token families whose
-- rows carry the OPERATOR's user id in `impersonator_user_id`
-- (`user_id` is the impersonated user, so downstream authorisation
-- acts as them). Null on every non-impersonation session — the
-- overwhelmingly common case, so the column is nullable with no
-- default and no backfill.
--
-- No new index: the only read path filters by family_id (already
-- indexed) and then checks impersonator_user_id on the fetched rows.
--
-- Forward-compatible expand-only migration: one nullable column.
--
-- Reversal plan:
--   ALTER TABLE "identity"."refresh_tokens" DROP COLUMN "impersonator_user_id";
-- Safe in isolation — nothing references the column outside
-- service-identity.

ALTER TABLE "identity"."refresh_tokens"
    ADD COLUMN "impersonator_user_id" TEXT;
