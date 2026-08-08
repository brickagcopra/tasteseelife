-- TS-024 — RBAC schema: Permission + Role + RolePermission + UserRole
-- (PDD §10.2 / Appendix B; CLAUDE.md §3.2).
--
-- Forward-compatible expand-only migration. Four new tables and one
-- new enum inside the existing `identity` schema. No changes to
-- `identity.users`, `identity.refresh_tokens`, `identity.mfa_methods`,
-- or `identity.mfa_challenges`.
--
-- Reversal plan: drop in reverse-creation order so the FKs unwind
-- cleanly:
--   DROP TABLE identity.user_roles;
--   DROP TYPE  identity.user_role_scope_type;
--   DROP TABLE identity.role_permissions;
--   DROP TABLE identity.roles;
--   DROP TABLE identity.permissions;
-- Safe in isolation because no other table references these (Phase 1).
-- The seeded catalog is recreated by `seedRbacCatalog` (idempotent),
-- so a rollback + redeploy restores the same state.
--
-- The schema design is documented in detail on the `Permission`,
-- `Role`, `RolePermission`, and `UserRole` models in `schema.prisma`.

-- CreateTable: permissions ------------------------------------------------
CREATE TABLE "identity"."permissions" (
    "id"          TEXT           NOT NULL,
    "resource"    TEXT           NOT NULL,
    "action"      TEXT           NOT NULL,
    "description" TEXT,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- (resource, action) is the natural key — a single permission per
-- pair. The compound unique index makes "is this permission known"
-- a single-key lookup at seed time.
CREATE UNIQUE INDEX "permissions_resource_action_key"
    ON "identity"."permissions"("resource", "action");

-- CreateTable: roles ------------------------------------------------------
CREATE TABLE "identity"."roles" (
    "id"          TEXT           NOT NULL,
    "name"        TEXT           NOT NULL,
    "description" TEXT,
    "is_system"   BOOLEAN        NOT NULL DEFAULT false,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- `name` is the global role identifier referenced by the access
-- token's `roles[*].name` claim. Unique across system + custom
-- roles.
CREATE UNIQUE INDEX "roles_name_key"
    ON "identity"."roles"("name");

-- Lets the seed code list all system roles in one indexed scan
-- without a sequential scan over custom roles.
CREATE INDEX "roles_is_system_idx"
    ON "identity"."roles"("is_system");

-- CreateTable: role_permissions ------------------------------------------
CREATE TABLE "identity"."role_permissions" (
    "role_id"       TEXT           NOT NULL,
    "permission_id" TEXT           NOT NULL,
    "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id")
);

-- Reverse-direction lookup: "which roles include this permission?"
-- Used by admin tooling and (in future) by permission-impact
-- analysis when a role's permission set changes.
CREATE INDEX "role_permissions_permission_id_idx"
    ON "identity"."role_permissions"("permission_id");

-- FK: role_permissions.role_id → roles.id (cascade — a deleted role
-- has no meaningful join rows).
ALTER TABLE "identity"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- FK: role_permissions.permission_id → permissions.id (cascade — a
-- deleted permission cannot have meaningful join rows).
ALTER TABLE "identity"."role_permissions"
    ADD CONSTRAINT "role_permissions_permission_id_fkey"
    FOREIGN KEY ("permission_id") REFERENCES "identity"."permissions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateEnum: user_role_scope_type ---------------------------------------
CREATE TYPE "identity"."user_role_scope_type" AS ENUM ('global', 'tenant', 'household');

-- CreateTable: user_roles -------------------------------------------------
CREATE TABLE "identity"."user_roles" (
    "id"                  TEXT                              NOT NULL,
    "user_id"             TEXT                              NOT NULL,
    "role_id"             TEXT                              NOT NULL,
    "scope_type"          "identity"."user_role_scope_type" NOT NULL,
    "scope_id"            TEXT,
    "granted_by_user_id"  TEXT,
    "expires_at"          TIMESTAMPTZ(6),
    "created_at"          TIMESTAMPTZ(6)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at"          TIMESTAMPTZ(6),

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- Per-user lookup. The dominant read path is "give me this user's
-- role assignments at login time" — this index covers the
-- userId-only filter; the compound below covers the active-only
-- variant.
CREATE INDEX "user_roles_user_id_idx"
    ON "identity"."user_roles"("user_id");

-- "Which users hold this role" — used by admin tooling.
CREATE INDEX "user_roles_role_id_idx"
    ON "identity"."user_roles"("role_id");

-- Powers `getActiveAssignments`: WHERE user_id = $1 AND revoked_at
-- IS NULL AND (expires_at IS NULL OR expires_at > now()). The
-- compound order matches the predicate — Postgres can satisfy the
-- user_id equality + revoked_at IS NULL + expires_at range in one
-- index scan.
CREATE INDEX "user_roles_user_active_idx"
    ON "identity"."user_roles"("user_id", "revoked_at", "expires_at");

-- FK: user_roles.role_id → roles.id (RESTRICT — a role with
-- outstanding assignments cannot be deleted; admin tooling must
-- explicitly revoke first).
ALTER TABLE "identity"."user_roles"
    ADD CONSTRAINT "user_roles_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
