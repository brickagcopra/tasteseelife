-- TS-510 — single-use email-verification tokens.
--
-- Closes the gap that made the platform unusable end to end: `users.status`
-- defaults to `pending_verification` (TS-020), `AuthService.login` requires
-- `active`, and no code path anywhere moved an account between the two.
-- `admin/users/:id/reinstate` requires a current status of `suspended`, so it
-- could not help either. Every account created through the platform's own
-- signup endpoint was permanently unable to log in. Found by the TS-505 E2E
-- suite on its second run.
--
-- **Shape.** One row per minted token: `token_hash` (SHA-256 of the bearer
-- token, UNIQUE so the verify path is a single-row lookup and never a scan),
-- `expires_at`, and a `consumed_at` tombstone stamped in the same transaction
-- that flips the user to `active`. A table rather than a column on `users`
-- because a resend must not invalidate a link the user may be about to click,
-- several tokens may legitimately be outstanding, and the spent rows are the
-- record of when the account was verified.
--
-- **Only the digest is stored.** The raw token travels in a URL; keeping the
-- digest means read access to this table cannot mint a working link
-- (CLAUDE.md §3.1). SHA-256 not bcrypt: the input is 256 bits of CSPRNG
-- output, so there is no dictionary to slow down, and a per-request bcrypt on
-- an unauthenticated endpoint is a denial-of-service lever.
--
-- Expand-only: one new table, no existing row or column touched. The FK to
-- `identity.users` is within this service's own schema (CLAUDE.md §4.1 —
-- never across service schemas) and cascades, because a token is meaningless
-- without the account it activates.
--
-- Reversal: `DROP TABLE identity.email_verification_tokens;`. Data
-- implication of reversing: outstanding verification links stop working and
-- the record of which accounts self-verified is lost — accounts already
-- flipped to `active` stay active, so no user is locked out by the reversal
-- itself, but anyone mid-signup has to be re-invited once the table returns.

CREATE TABLE "identity"."email_verification_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- The verify path's only lookup: `WHERE token_hash = $1`. UNIQUE both enforces
-- that a presented token identifies at most one row and provides that index.
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key"
    ON "identity"."email_verification_tokens"("token_hash");

-- EXPLAIN: the resend path asks "does this user already hold a spendable
-- token?" — `WHERE user_id = $1 AND consumed_at IS NULL`. A bare `user_id`
-- index would work but this composite lets the planner satisfy the predicate
-- from the index alone, and the same index serves the expired-row prune
-- (TS-510-followup-1) which scans by user then filters on the tombstone.
CREATE INDEX "email_verification_tokens_user_id_consumed_at_idx"
    ON "identity"."email_verification_tokens"("user_id", "consumed_at");

ALTER TABLE "identity"."email_verification_tokens"
    ADD CONSTRAINT "email_verification_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
