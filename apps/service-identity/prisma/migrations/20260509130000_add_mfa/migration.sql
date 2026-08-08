-- TS-023 — TOTP MFA enrollment + verification (PDD §10.1, CLAUDE.md §3.1).
--
-- Forward-compatible expand-only migration. Two new tables inside the
-- existing `identity` schema, plus one new enum (`mfa_method_kind`).
-- No changes to `identity.users` or `identity.refresh_tokens`. Reversal
-- plan: `DROP TABLE identity.mfa_challenges; DROP TABLE
-- identity.mfa_methods; DROP TYPE identity.mfa_method_kind;` — safe in
-- isolation because no other table references these yet (Phase 1).
--
-- The schema design is documented in detail on the `MfaMethod` and
-- `MfaChallenge` models in `schema.prisma`. SQL is hand-authored to
-- match Prisma 5.x's emit shape so `prisma migrate deploy` applies it
-- without drift.

CREATE TYPE "identity"."mfa_method_kind" AS ENUM ('totp', 'sms_backup');

CREATE TABLE "identity"."mfa_methods" (
    "id"                TEXT                          NOT NULL,
    "user_id"           TEXT                          NOT NULL,
    "kind"              "identity"."mfa_method_kind"  NOT NULL,
    "secret_ciphertext" BYTEA                         NOT NULL,
    "secret_iv"         BYTEA                         NOT NULL,
    "secret_auth_tag"   BYTEA                         NOT NULL,
    "key_version"       INTEGER                       NOT NULL,
    "label"             TEXT,
    -- BIGINT because the RFC 6238 step counter is Unix seconds / period.
    -- Currently in the int4-safe range, but TOTP step counters are
    -- monotonic over time and we don't want to revisit this column in
    -- 2038 — bigint is free at storage cost on disk.
    "last_used_step"    BIGINT,
    "confirmed_at"      TIMESTAMPTZ(6),
    "last_used_at"      TIMESTAMPTZ(6),
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at"        TIMESTAMPTZ(6),

    CONSTRAINT "mfa_methods_pkey" PRIMARY KEY ("id")
);

-- Per-user lookup. Required for "list this user's methods", which is
-- the dominant read path against this table.
CREATE INDEX "mfa_methods_user_id_idx"
    ON "identity"."mfa_methods"("user_id");

-- Compound index for "active confirmed methods for this user" — the
-- exact predicate `MfaService.verifyForChallenge` runs to find a code's
-- candidate row. Ordered (user_id, deleted_at, confirmed_at) so a
-- single-user lookup with `deleted_at IS NULL AND confirmed_at IS NOT
-- NULL` is index-only.
CREATE INDEX "mfa_methods_user_active_idx"
    ON "identity"."mfa_methods"("user_id", "deleted_at", "confirmed_at");

CREATE TABLE "identity"."mfa_challenges" (
    "id"          TEXT           NOT NULL,
    "user_id"     TEXT           NOT NULL,
    "expires_at"  TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip"          TEXT,
    "user_agent"  TEXT,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- Per-user lookup (audit "show this user's recent MFA challenges").
CREATE INDEX "mfa_challenges_user_id_idx"
    ON "identity"."mfa_challenges"("user_id");

-- Expiry-driven cleanup (a future janitor worker prunes by
-- `expires_at`).
CREATE INDEX "mfa_challenges_expires_at_idx"
    ON "identity"."mfa_challenges"("expires_at");
