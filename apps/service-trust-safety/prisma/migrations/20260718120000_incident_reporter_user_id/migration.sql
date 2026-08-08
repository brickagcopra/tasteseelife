-- TS-301b — who filed the report, on `incidents`.
--
-- Expand-only (CLAUDE.md §4.1): adds a nullable `reporter_user_id` column
-- carrying the verified `userId` of the actor who filed the incident, stamped
-- from the access token — NEVER from the request body.
--
-- Why this column has to exist before the provider surface ships: until now
-- attribution rode entirely on the subject-id scrolls (`household_id` /
-- `senior_id` / `provider_id`). That works for the TS-301a family/senior path,
-- where `household_id` comes off the token scope. It does NOT work for the
-- TS-301b provider path: a provider's token carries `tenantScope: global` and
-- there is no `providerId` claim anywhere in the auth contract
-- (`packages/auth-sdk/src/scope.ts`), so a provider-filed incident would land
-- with household_id, senior_id AND provider_id all NULL — an orphan row in the
-- operator queue with no way back to the filer.
--
-- Deliberately NOT solved by letting the provider self-assert `providerId` in
-- the body: that would let any provider attribute a concern to a different
-- provider (identity spoofing on a trust & safety surface). The verified
-- reporter id is the trustworthy anchor; `provider_id` stays NULL on that path
-- and is resolved by async linkage at triage (TS-301b-followup-1).
--
-- Nullable because system-sourced incidents (TS-302 event ingestion) have no
-- human filer.
--
-- PII discipline: this is an opaque internal user id, not contact data. It is
-- an operator-surface field only and never rides outbox events or logs
-- (CLAUDE.md §3.9, §10) — same posture as `description`.
--
-- Index rationale: "incidents filed by actor X" is the abuse-pattern predicate
-- for the trust & safety queue (a single actor flooding reports is itself a
-- trust signal — CLAUDE.md §12 coupon-abuse-style rate concerns), and it is a
-- row-level scoping predicate for "my reports" reads. Matches the existing
-- subject-id scroll indexes.
--   EXPLAIN: sequential scan on incidents once the table passes ~10k rows;
--   btree on (reporter_user_id) keeps the filer scroll an index scan.
--
-- Reversal plan:
--   DROP INDEX "trust_safety"."trust_safety_incidents_reporter_user_id_idx";
--   ALTER TABLE "trust_safety"."incidents" DROP COLUMN "reporter_user_id";

ALTER TABLE "trust_safety"."incidents" ADD COLUMN "reporter_user_id" TEXT;

CREATE INDEX "trust_safety_incidents_reporter_user_id_idx"
  ON "trust_safety"."incidents" ("reporter_user_id");
