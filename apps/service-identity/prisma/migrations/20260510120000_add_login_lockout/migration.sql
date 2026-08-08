-- TS-025 — Per-user failed-login lockout columns on identity.users
-- (CLAUDE.md §3.1). The IP-level circuit breaker described in the
-- same section is intentionally not part of this migration — it
-- lands as TS-025-followup-1 once Redis is wired (TS-009e / TS-044).
--
-- Forward-compatible expand-only migration. Three new columns and
-- one partial index on `identity.users`. No changes to other tables.
--
-- Existing rows: `failed_login_count` defaults to 0 (no failures
-- recorded against pre-existing users — accurate, since the lockout
-- subsystem only starts tracking from this migration onward);
-- `last_failed_login_at` and `locked_until` default to NULL ("no
-- failures recorded" / "not locked"). Backfilling these columns is
-- not necessary; the lockout state machine starts from a clean
-- slate for every user.
--
-- Reversal plan: drop the partial index, then drop the three
-- columns in reverse-declaration order:
--   DROP INDEX  IF EXISTS "identity"."users_locked_until_idx";
--   ALTER TABLE "identity"."users" DROP COLUMN "locked_until";
--   ALTER TABLE "identity"."users" DROP COLUMN "last_failed_login_at";
--   ALTER TABLE "identity"."users" DROP COLUMN "failed_login_count";
-- Safe in isolation — no other table references these columns and
-- no FK/CHECK constraints rely on them. Rolling back resets the
-- lockout policy without affecting any other authentication state
-- (passwords, MFA, RBAC remain intact). A redeploy after rollback
-- restarts the lockout state machine from zero.

-- AlterTable: identity.users — add failed_login_count -------------------
ALTER TABLE "identity"."users"
    ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: identity.users — add last_failed_login_at -----------------
ALTER TABLE "identity"."users"
    ADD COLUMN "last_failed_login_at" TIMESTAMPTZ(6);

-- AlterTable: identity.users — add locked_until -------------------------
ALTER TABLE "identity"."users"
    ADD COLUMN "locked_until" TIMESTAMPTZ(6);

-- CreateIndex: users_locked_until_idx (partial) -------------------------
-- Most users are never locked; a full-row index on `locked_until`
-- would index hundreds of thousands of NULLs to serve the rare
-- admin "currently-locked users" query. The partial filter sizes
-- the index to the population that actually matters. Postgres can
-- still use the index for `WHERE locked_until > now()` because the
-- predicate implies `locked_until IS NOT NULL`.
CREATE INDEX "users_locked_until_idx"
    ON "identity"."users"("locked_until")
    WHERE "locked_until" IS NOT NULL;
