-- TS-126-followup-6 — Promote `user_roles.user_id` from a soft FK to a
-- real FK constraint so the admin-users role-filter can collapse to a
-- one-step Prisma `where: { roles: { some: ... } }` semi-join (see
-- `apps/service-identity/src/modules/admin/services/admin-users.service.ts`).
--
-- Forward-compatible expand-only migration. Adds ONE FK constraint;
-- adds no columns, indexes, or new tables. The existing `user_id`
-- column on `identity.user_roles` is unchanged — only the relational
-- guarantee is new.
--
-- The TS-024 migration intentionally left `user_id` as a soft FK
-- because Phase 1 kept the relation graph small (per the prior
-- model doc-comment "the FK can be added in a forward-compatible
-- migration without changing the table"). The admin-users role-filter
-- read pattern is the first relation query that materially benefits
-- from declaring the relation; the FK lands here as the realisation
-- of that planned upgrade.
--
-- ON DELETE RESTRICT — a user with outstanding role assignments
-- cannot be hard-deleted; admin tooling must explicitly revoke
-- assignments first. Soft-delete via `users.deleted_at` remains the
-- default mechanism per the User model header doc.
--
-- ON UPDATE CASCADE — matches the existing `user_roles_role_id_fkey`
-- convention (TS-024 migration). User ids are CUIDs and never
-- re-keyed in practice; the cascade is the cheap-defence default.
--
-- Reversal plan:
--   ALTER TABLE "identity"."user_roles"
--       DROP CONSTRAINT "user_roles_user_id_fkey";
-- Safe in isolation — the constraint is the only new artifact.

-- FK: user_roles.user_id → users.id (RESTRICT — a user with
-- outstanding assignments cannot be deleted; admin tooling must
-- revoke first).
ALTER TABLE "identity"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
