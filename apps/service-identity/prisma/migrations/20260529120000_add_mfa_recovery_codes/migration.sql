-- TS-023-followup-2 — One-time MFA recovery (backup) codes (PDD §10.1,
-- CLAUDE.md §3.1).
--
-- Forward-compatible expand-only migration. One new table inside the
-- existing `identity` schema. No changes to `identity.users`,
-- `identity.mfa_methods`, or any other existing table. Reversal plan:
-- `DROP TABLE identity.mfa_recovery_codes;` — safe in isolation
-- because no other table references it (soft FK to `users` by id only,
-- matching the RefreshToken / MfaMethod / MfaChallenge convention).
--
-- The schema design is documented in detail on the `MfaRecoveryCode`
-- model in `schema.prisma`. SQL is hand-authored to match Prisma 5.x's
-- emit shape so `prisma migrate deploy` applies it without drift.

CREATE TABLE "identity"."mfa_recovery_codes" (
    "id"          TEXT           NOT NULL,
    "user_id"     TEXT           NOT NULL,
    -- SHA-256(normalisedCode) base64url. Hashed, not encrypted: the raw
    -- value is a high-entropy opaque token the server never needs to
    -- recover — it only compares a presented code's hash against this.
    -- Same reasoning as identity.refresh_tokens.token_hash.
    "code_hash"   TEXT           NOT NULL,
    -- Single-use tombstone. NULL = unused; set the first (and only)
    -- time a code is accepted at the recovery-verify endpoint.
    "consumed_at" TIMESTAMPTZ(6),
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- Globally-unique hash so a presented code maps to exactly zero or one
-- row — the verify path is a single-row lookup keyed by this column,
-- then scoped to the presenting user.
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key"
    ON "identity"."mfa_recovery_codes" ("code_hash");

-- Per-user lookup — powers batch delete on re-enrol / MFA-disable and
-- the future "how many recovery codes remain?" surface. The verify
-- path uses the unique code_hash index above, not this one.
CREATE INDEX "mfa_recovery_codes_user_id_idx"
    ON "identity"."mfa_recovery_codes" ("user_id");
