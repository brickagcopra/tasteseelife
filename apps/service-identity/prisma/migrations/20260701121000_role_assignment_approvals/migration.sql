-- TS-024-followup-4 (schema-first for TS-294) — reviewer-required
-- grant requests for sensitive roles (CLAUDE.md §3.2 "Privilege
-- escalation requires audit + reviewer signoff for sensitive roles"
-- — `super_admin`, `finance`; PDD §10.3).
--
-- Forward-compatible expand-only migration: one new enum + one new
-- table inside the existing `identity` schema. No changes to any
-- existing table. The approval FLOW (request → second-admin decision
-- → grant activation) arrives in TS-294; this lands the data shape
-- now so the RBAC admin tooling track (TS-290+) needs no second
-- migration.
--
-- Design (documented in full on the `RoleAssignmentApproval` model):
-- a pending-REQUEST row carrying the complete requested grant
-- parameters. The real `identity.user_roles` row is only inserted
-- when a second admin approves, so a half-active grant never exists
-- and token issuance keeps reading `user_roles` alone.
--
-- Reversal plan (drop in reverse-creation order):
--   DROP TABLE "identity"."role_assignment_approvals";
--   DROP TYPE  "identity"."role_assignment_approval_status";
-- Safe in isolation — nothing references the table (Phase 1) and
-- `user_roles` is untouched.

-- CreateEnum: role_assignment_approval_status -----------------------------
CREATE TYPE "identity"."role_assignment_approval_status"
    AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateTable: role_assignment_approvals ----------------------------------
CREATE TABLE "identity"."role_assignment_approvals" (
    "id"                   TEXT                                          NOT NULL,
    "user_id"              TEXT                                          NOT NULL,
    "role_id"              TEXT                                          NOT NULL,
    "scope_type"           "identity"."user_role_scope_type"             NOT NULL,
    "scope_id"             TEXT,
    "expires_at"           TIMESTAMPTZ(6),
    "requested_by_user_id" TEXT                                          NOT NULL,
    "reason"               TEXT,
    "status"               "identity"."role_assignment_approval_status" NOT NULL DEFAULT 'pending',
    "approved_by_user_id"  TEXT,
    "decided_at"           TIMESTAMPTZ(6),
    "user_role_id"         TEXT,
    "created_at"           TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ(6)                                NOT NULL,

    CONSTRAINT "role_assignment_approvals_pkey" PRIMARY KEY ("id")
);

-- One approval mints at most one grant — the back-link to the
-- `user_roles` row created on approval is unique (and null while
-- pending / rejected / expired).
CREATE UNIQUE INDEX "role_assignment_approvals_user_role_id_key"
    ON "identity"."role_assignment_approvals"("user_role_id");

-- FK-side lookup: "which approval requests target this user?"
-- (grantee history view in admin tooling).
CREATE INDEX "role_assignment_approvals_user_id_idx"
    ON "identity"."role_assignment_approvals"("user_id");

-- FK-side lookup: "which approval requests target this role?"
-- (per-role escalation history).
CREATE INDEX "role_assignment_approvals_role_id_idx"
    ON "identity"."role_assignment_approvals"("role_id");

-- Powers the reviewer-queue read — WHERE status = 'pending' ORDER BY
-- created_at — and status-filtered history views. Compound order
-- matches the predicate then the sort.
CREATE INDEX "role_assignment_approvals_status_created_idx"
    ON "identity"."role_assignment_approvals"("status", "created_at");

-- Duplicate-pending guard: at most ONE open request per exact grant
-- (user, role, scope). Mirrors `user_roles_active_unique_idx`
-- (TS-024-followup-3) including the NULLS NOT DISTINCT rationale —
-- global-scope requests carry a NULL scope_id, which default unique
-- semantics would treat as always-distinct. Decided rows (approved /
-- rejected / expired) are exempt, so a re-request after a rejection
-- is legal. Raw-SQL only — Prisma cannot model partial /
-- nulls-not-distinct indexes; documented on the model doc-comment.
CREATE UNIQUE INDEX "role_assignment_approvals_pending_unique_idx"
    ON "identity"."role_assignment_approvals"("user_id", "role_id", "scope_type", "scope_id")
    NULLS NOT DISTINCT
    WHERE "status" = 'pending';

-- FK: role_assignment_approvals.user_id → users.id (RESTRICT — a
-- user with approval history cannot be hard-deleted; matches
-- `user_roles_user_id_fkey`).
ALTER TABLE "identity"."role_assignment_approvals"
    ADD CONSTRAINT "role_assignment_approvals_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: role_assignment_approvals.role_id → roles.id (RESTRICT — a
-- role with approval history cannot be deleted; matches
-- `user_roles_role_id_fkey`).
ALTER TABLE "identity"."role_assignment_approvals"
    ADD CONSTRAINT "role_assignment_approvals_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "identity"."roles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: role_assignment_approvals.user_role_id → user_roles.id
-- (RESTRICT — a minted grant row cannot be hard-deleted from under
-- its approval record; grants are revoked, never deleted).
ALTER TABLE "identity"."role_assignment_approvals"
    ADD CONSTRAINT "role_assignment_approvals_user_role_id_fkey"
    FOREIGN KEY ("user_role_id") REFERENCES "identity"."user_roles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
