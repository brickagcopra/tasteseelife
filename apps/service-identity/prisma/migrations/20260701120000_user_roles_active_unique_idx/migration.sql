-- TS-024-followup-3 — Partial unique index rejecting duplicate ACTIVE
-- role assignments (CLAUDE.md §4.1; `RoleAssignmentService.grant`
-- doc-comment previously read "Does NOT enforce uniqueness" — with
-- TS-290 admin tooling becoming the primary grant surface, the
-- belt-and-braces DB guard lands now and the service maps the
-- resulting P2002 to a 409 Conflict).
--
-- Forward-compatible expand-only migration: one data-repair UPDATE +
-- one new index. No new columns, tables, or FKs.
--
-- Index design (why not the bare 4-column partial index the task
-- names): `scope_id` is NULL for every global-scope grant, and
-- Postgres treats NULLs as DISTINCT in unique indexes by default —
-- a bare `(user_id, role_id, scope_type, scope_id) WHERE revoked_at
-- IS NULL` index would therefore NOT reject a duplicate global
-- grant, which is exactly the dominant duplicate case (signup's
-- `family_payer`, admin roles). PostgreSQL 16 (the platform's
-- pinned major — PDD §4) supports `NULLS NOT DISTINCT`, which makes
-- two NULL scope_ids compare equal and closes the hole with plain
-- columns (no COALESCE expression, so the index stays usable as a
-- plain btree on the leading columns and Prisma's P2002 machinery
-- reports the constraint name cleanly). The `WHERE revoked_at IS
-- NULL` predicate exempts revoked HISTORY rows — re-granting after
-- a revoke stays legal, and the audit trail keeps every superseded
-- row.
--
-- Prisma cannot model partial / NULLS NOT DISTINCT indexes, so this
-- index is raw-SQL-only and documented on the `UserRole` model
-- doc-comment (same convention as the repo's other partial indexes,
-- e.g. service-provider's `revoked_at IS NULL` certification
-- indexes).
--
-- EXPLAIN note: the index additionally serves as a fast existence
-- probe for "does this exact active grant already exist" lookups
-- (leading-column btree on user_id), though the dedicated
-- `user_roles_user_active_idx` remains the hot-path index for
-- `getActiveAssignments`.
--
-- Data repair (must precede the index): any pre-existing duplicate
-- active grants would abort CREATE UNIQUE INDEX. Duplicates are
-- only possible from repeated system grants (signup retries) since
-- no admin grant surface exists yet; we keep the NEWEST row of each
-- duplicate group and revoke the older ones (revocation — not
-- deletion — so the audit trail survives; ties broken by id for
-- determinism). Idempotent: re-running matches zero rows.
--
-- Reversal plan:
--   DROP INDEX "identity"."user_roles_active_unique_idx";
-- Safe in isolation — the data-repair UPDATE is a one-way tombstone
-- write but only ever touches redundant duplicate rows.

-- Data repair: revoke all but the newest row of each active
-- duplicate group.
UPDATE "identity"."user_roles"
SET "revoked_at" = CURRENT_TIMESTAMP
WHERE "revoked_at" IS NULL
  AND "id" IN (
    SELECT dup."id"
    FROM (
      SELECT "id",
             ROW_NUMBER() OVER (
               PARTITION BY "user_id", "role_id", "scope_type", COALESCE("scope_id", '')
               ORDER BY "created_at" DESC, "id" DESC
             ) AS rn
      FROM "identity"."user_roles"
      WHERE "revoked_at" IS NULL
    ) dup
    WHERE dup.rn > 1
  );

-- The dedup guard itself.
CREATE UNIQUE INDEX "user_roles_active_unique_idx"
    ON "identity"."user_roles"("user_id", "role_id", "scope_type", "scope_id")
    NULLS NOT DISTINCT
    WHERE "revoked_at" IS NULL;
