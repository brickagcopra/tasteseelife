-- TS-309a — data-subject request record + lifecycle.
--
-- The spine of the Privacy Center (PRD §11.4; PDD §16.3, §16.4). TS-309b
-- assembles the export against this row; TS-309c would execute an erasure
-- and is compliance-blocked.
--
-- **Why this table keeps three things apart.** The original acceptance said
-- "users export their data", which holds only when the account holder and
-- the data subject are the same person. On this platform they routinely are
-- not: the senior is who most of the data is about, and the family payer
-- holds the account. So every row carries a REQUESTER (stamped from the
-- verified access token), a SUBJECT (who the data is about), and a
-- VERIFICATION linking them — and without the third, nothing is handed over.
--
-- Where the subject is a senior and the requester is a family member,
-- `household.senior_consent` governs what may be shared at all (CLAUDE.md
-- §12). An export that ignored it would breach the platform's own consent
-- model in the course of satisfying a privacy request. `self_service` is what
-- makes that case representable but never automatic.
--
-- Expand-only: four new enum types, one new table, no existing row touched.
-- Reversal is `DROP TABLE identity.data_subject_requests;` followed by the
-- four `DROP TYPE`s. Data implication of reversing: every recorded privacy
-- request and every recorded refusal is lost, which is the evidence a
-- regulator would ask for — so a reversal should export the table first.

CREATE TYPE "identity"."data_subject_request_kind" AS ENUM ('access', 'erasure');

CREATE TYPE "identity"."data_subject_kind" AS ENUM ('user', 'senior', 'provider');

CREATE TYPE "identity"."data_subject_request_status" AS ENUM (
  'received', 'verifying', 'in_progress', 'fulfilled', 'refused', 'withdrawn'
);

CREATE TYPE "identity"."data_subject_request_refusal_reason" AS ENUM (
  'identity_not_verified',
  'not_the_subject',
  'subject_consent_absent',
  'retention_required',
  'duplicate_request',
  'out_of_scope'
);

CREATE TABLE "identity"."data_subject_requests" (
  "id"                  TEXT NOT NULL,
  "requester_user_id"   TEXT NOT NULL,
  "subject_kind"        "identity"."data_subject_kind" NOT NULL,
  "subject_id"          TEXT NOT NULL,
  "self_service"        BOOLEAN NOT NULL,
  "kind"                "identity"."data_subject_request_kind" NOT NULL,
  "status"              "identity"."data_subject_request_status" NOT NULL DEFAULT 'received',
  "note"                TEXT,
  "received_at"         TIMESTAMPTZ(6) NOT NULL,
  "due_at"              TIMESTAMPTZ(6) NOT NULL,
  "extended_at"         TIMESTAMPTZ(6),
  "extension_reason"    TEXT,
  "verified_at"         TIMESTAMPTZ(6),
  "verified_by_user_id" TEXT,
  "verification_method" TEXT,
  "fulfilled_at"        TIMESTAMPTZ(6),
  "refused_at"          TIMESTAMPTZ(6),
  "refusal_reason"      "identity"."data_subject_request_refusal_reason",
  "refusal_note"        TEXT,
  "withdrawn_at"        TIMESTAMPTZ(6),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "data_subject_requests_pkey" PRIMARY KEY ("id")
);

-- The requester is always a user of THIS service, so this is a real FK.
-- RESTRICT rather than CASCADE: a privacy request is the record of a legal
-- interaction, and deleting the account must not silently delete the
-- evidence that the account holder once asked to be told what we hold.
ALTER TABLE "identity"."data_subject_requests"
  ADD CONSTRAINT "data_subject_requests_requester_user_id_fkey"
  FOREIGN KEY ("requester_user_id") REFERENCES "identity"."users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The verification trail is all-or-nothing. A row with a timestamp but no
-- verifier, or a verifier with no stated method, would read as "verified by
-- nobody for no reason" — which is worse than unverified, because it looks
-- like an answer. The service sets all three together; this makes the
-- half-written state unrepresentable regardless (CLAUDE.md §4.1).
ALTER TABLE "identity"."data_subject_requests"
  ADD CONSTRAINT "data_subject_requests_verification_complete_chk"
  CHECK (
    ("verified_at" IS NULL AND "verified_by_user_id" IS NULL AND "verification_method" IS NULL)
    OR
    ("verified_at" IS NOT NULL AND "verified_by_user_id" IS NOT NULL AND "verification_method" IS NOT NULL)
  );

-- A refusal must state a categorical reason, and a reason must accompany a
-- refusal. "No" without a recorded why is the opacity these laws exist to
-- prevent, and a reason on a non-refused row is a lie waiting to be read.
ALTER TABLE "identity"."data_subject_requests"
  ADD CONSTRAINT "data_subject_requests_refusal_paired_chk"
  CHECK (
    ("refused_at" IS NULL AND "refusal_reason" IS NULL)
    OR
    ("refused_at" IS NOT NULL AND "refusal_reason" IS NOT NULL)
  );

-- The extension is a single, explicit, reasoned act. A deadline that moves
-- without anyone deciding it should is not a deadline.
ALTER TABLE "identity"."data_subject_requests"
  ADD CONSTRAINT "data_subject_requests_extension_paired_chk"
  CHECK (
    ("extended_at" IS NULL AND "extension_reason" IS NULL)
    OR
    ("extended_at" IS NOT NULL AND "extension_reason" IS NOT NULL)
  );

-- "My requests", newest first — the requester-facing list.
CREATE INDEX "data_subject_requests_requester_idx"
  ON "identity"."data_subject_requests" ("requester_user_id", "received_at");

-- "Everything we have been asked about this person" — the intake duplicate
-- check, and the answer an operator needs when a senior's family calls twice.
CREATE INDEX "data_subject_requests_subject_idx"
  ON "identity"."data_subject_requests" ("subject_kind", "subject_id");

-- The operator queue: live requests, deadline soonest first.
--
-- PARTIAL on the three live statuses. Steady state is dominated by terminal
-- rows (every request eventually ends), so a full index would grow without
-- bound while serving a query that only ever wants the small live set.
-- Prisma's `@@index` cannot express the predicate, so the model declares the
-- plain form and this owns the real DDL (CLAUDE.md §7.3).
--
--   EXPLAIN (before): Seq Scan on data_subject_requests
--                       Filter: ((status <> ALL ('{fulfilled,refused,withdrawn}')) ...)
--   EXPLAIN (after) : Index Scan using data_subject_requests_open_due_idx
--                       Index Cond: (due_at IS NOT NULL)
CREATE INDEX "data_subject_requests_open_due_idx"
  ON "identity"."data_subject_requests" ("due_at")
  WHERE "status" IN ('received', 'verifying', 'in_progress');
