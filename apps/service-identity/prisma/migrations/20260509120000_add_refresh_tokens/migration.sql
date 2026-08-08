-- TS-022 — rotating refresh tokens with reuse detection (CLAUDE.md §3.1, §17.4).
--
-- Forward-compatible expand-only migration: introduces a new table inside
-- the existing `identity` schema. No changes to `identity.users`. Reversal
-- is `DROP TABLE identity.refresh_tokens` — safe in isolation because no
-- other table references this one yet (Phase 1).
--
-- The schema design is documented in detail on the `RefreshToken` model
-- in `schema.prisma`. SQL is hand-authored to match Prisma 5.x's emit
-- shape so `prisma migrate deploy` applies it without drift.

CREATE TABLE "identity"."refresh_tokens" (
    "id"          TEXT          NOT NULL,
    "family_id"   TEXT          NOT NULL,
    "user_id"     TEXT          NOT NULL,
    "token_hash"  TEXT          NOT NULL,
    "issued_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"  TIMESTAMPTZ(6) NOT NULL,
    "rotated_at"  TIMESTAMPTZ(6),
    "revoked_at"  TIMESTAMPTZ(6),
    "ip"          TEXT,
    "user_agent"  TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- Unique on token_hash — a presented raw token deterministically maps to
-- one row (or zero). Used by /refresh to look up the presented token in
-- a single primary-key-equivalent lookup.
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key"
    ON "identity"."refresh_tokens"("token_hash");

-- Per-user lookup (admin "log out everywhere", security incident review).
CREATE INDEX "refresh_tokens_user_id_idx"
    ON "identity"."refresh_tokens"("user_id");

-- Per-family lookup (rotation, family revocation).
CREATE INDEX "refresh_tokens_family_id_idx"
    ON "identity"."refresh_tokens"("family_id");

-- Expiry-driven cleanup (a future janitor worker prunes by `expires_at`).
CREATE INDEX "refresh_tokens_expires_at_idx"
    ON "identity"."refresh_tokens"("expires_at");
