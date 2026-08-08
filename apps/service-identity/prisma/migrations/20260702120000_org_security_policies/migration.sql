-- TS-296 — per-organisation security policy (CLAUDE.md §3.1 "SSO +
-- 2FA enforcement for admin staff"; PDD §10.1).
--
-- Identity has no org/tenant entity; tenancy is the bare `scope_id`
-- string on tenant-scoped `user_roles` rows. This table hosts
-- security flags keyed by that same scope id, starting with
-- `sso_required` — when true, an admin-staff login whose active
-- admin assignments touch the scope must arrive SSO-asserted or the
-- session is refused. The well-known row `scope_id = 'global'`
-- governs global-scoped admin staff.
--
-- Forward-compatible expand-only migration: one new table, no
-- changes to any existing table.
--
-- Reversal plan:
--   DROP TABLE "identity"."org_security_policies";
-- Safe in isolation — nothing references the table.

-- CreateTable: org_security_policies ---------------------------------------
CREATE TABLE "identity"."org_security_policies" (
    "id"           TEXT           NOT NULL,
    "scope_id"     TEXT           NOT NULL,
    "sso_required" BOOLEAN        NOT NULL DEFAULT false,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "org_security_policies_pkey" PRIMARY KEY ("id")
);

-- One policy row per scope; also the login hot path's lookup index
-- (`WHERE scope_id IN (...) AND sso_required = true`), paid only
-- when the user holds an admin role.
CREATE UNIQUE INDEX "org_security_policies_scope_id_key"
    ON "identity"."org_security_policies"("scope_id");
