-- TS-303a — mandated-reporter workflow: per-state jurisdiction kit +
-- per-incident case, with the reviewer-signoff gate that CLAUDE.md §12
-- ("abuse/neglect flags route to the mandated reporter workflow per state.
-- Never auto-close") requires. PRD §10.14, §11.4; PDD §16.1, §16.4.
--
-- Forward-only expand migration. Two new tables + two new enums in the
-- `trust_safety` schema; the existing `incidents` table is NOT touched —
-- the case row references it, not the other way round, so nothing about
-- intake or the TS-301 surfaces changes shape.
--
-- Why the case row is the "suspected elder abuse" tag, rather than a
-- column on `incidents`: routing an incident into a statutory filing
-- pathway is a legal judgement made by a trained operator. Deriving it
-- from `category = 'welfare' AND severity >= 'high'` would manufacture
-- filings against families who reported a missed meal, and the filer-facing
-- category taxonomy is deliberately left alone (a family should not pick
-- "abuse" from a dropdown — CLAUDE.md §12, hospitality not clinical).
--
-- LEGAL REFERENCE DATA WARNING. `mandated_reporter_jurisdictions` ships
-- EMPTY and every row that lands in it defaults to `verified = false` /
-- `platform_role = 'undetermined'`. The platform does not author elder-abuse
-- reporting law: duties, recipient agencies, and statutory windows vary by
-- state and change by legislative session. The service layer refuses to
-- advance a case to `filing_prep` against an unverified jurisdiction, so an
-- unpopulated table degrades to "this workflow is not usable in that state
-- yet" — loudly — rather than to a confidently wrong hotline number. There
-- is deliberately NO seed of guessed values in this migration.
--
-- Reversal plan (safe in isolation — nothing else references these tables):
--   DROP INDEX IF EXISTS "trust_safety"."mandated_reporter_cases_statutory_due_idx";
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_mandated_reporter_cases_state_code_idx";
--   DROP INDEX IF EXISTS "trust_safety"."trust_safety_mandated_reporter_cases_status_idx";
--   DROP TABLE IF EXISTS "trust_safety"."mandated_reporter_cases";
--   DROP INDEX IF EXISTS "trust_safety"."mandated_reporter_jurisdictions_unverified_idx";
--   DROP TABLE IF EXISTS "trust_safety"."mandated_reporter_jurisdictions";
--   DROP TYPE  IF EXISTS "trust_safety"."mandated_reporter_case_status";
--   DROP TYPE  IF EXISTS "trust_safety"."mandated_reporter_platform_role";
-- Order matters: cases FK both incidents and jurisdictions.
--
-- Apply locally with:
--   pnpm -F @taste-and-see/service-trust-safety prisma:migrate:deploy
-- against a Postgres reachable at $DATABASE_URL.

CREATE TYPE "trust_safety"."mandated_reporter_platform_role" AS ENUM (
    'mandated',
    'permissive',
    'undetermined'
);

CREATE TYPE "trust_safety"."mandated_reporter_case_status" AS ENUM (
    'screening',
    'filing_prep',
    'filed',
    'not_reportable',
    'signed_off'
);

CREATE TABLE "trust_safety"."mandated_reporter_jurisdictions" (
    "state_code"               CHAR(2) NOT NULL,
    "agency_name"              TEXT,
    "reporting_phone"          TEXT,
    "reporting_url"            TEXT,
    "statutory_deadline_hours" INTEGER,
    "platform_role"            "trust_safety"."mandated_reporter_platform_role" NOT NULL DEFAULT 'undetermined',
    "statute_citation"         TEXT,
    "verified"                 BOOLEAN NOT NULL DEFAULT FALSE,
    "verified_at"              TIMESTAMPTZ(6),
    "verified_by_user_id"      TEXT,
    "notes"                    TEXT,
    "created_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mandated_reporter_jurisdictions_pkey" PRIMARY KEY ("state_code"),
    -- USPS codes are uppercase; a lowercase 'ny' alongside 'NY' would be two
    -- jurisdictions for one state, which on this surface means an incident
    -- silently matched against an empty kit.
    CONSTRAINT "mandated_reporter_jurisdictions_state_code_upper_check"
      CHECK ("state_code" = UPPER("state_code")),
    -- A deadline of zero or negative hours is a data-entry error, and the
    -- value is arithmetic input for `statutory_due_at`.
    CONSTRAINT "mandated_reporter_jurisdictions_deadline_positive_check"
      CHECK ("statutory_deadline_hours" IS NULL OR "statutory_deadline_hours" > 0),
    -- Verification is an accountable act: a row cannot claim to be verified
    -- without recording who verified it and when (CLAUDE.md §3.6).
    CONSTRAINT "mandated_reporter_jurisdictions_verified_attribution_check"
      CHECK (
        "verified" = FALSE
        OR ("verified_at" IS NOT NULL AND "verified_by_user_id" IS NOT NULL)
      )
);

-- Partial index: the compliance backlog scroll ("which states have we not
-- checked yet"). Steady state once the kit is populated is overwhelmingly
-- verified rows, so the predicate keeps the index to the work queue
-- (CLAUDE.md §7.3). Prisma's `@@index` cannot express the predicate.
CREATE INDEX "mandated_reporter_jurisdictions_unverified_idx"
    ON "trust_safety"."mandated_reporter_jurisdictions" ("state_code")
    WHERE "verified" = FALSE;

CREATE TABLE "trust_safety"."mandated_reporter_cases" (
    "id"                  TEXT NOT NULL,
    "incident_id"         TEXT NOT NULL,
    "state_code"          CHAR(2) NOT NULL,
    "status"              "trust_safety"."mandated_reporter_case_status" NOT NULL DEFAULT 'screening',
    "opened_by_user_id"   TEXT NOT NULL,
    "opened_at"           TIMESTAMPTZ(6) NOT NULL,
    "statutory_due_at"    TIMESTAMPTZ(6),
    "filed_at"            TIMESTAMPTZ(6),
    "filing_reference"    TEXT,
    "determination_notes" TEXT,
    "reviewer_user_id"    TEXT,
    "reviewed_at"         TIMESTAMPTZ(6),
    "reviewer_notes"      TEXT,
    "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mandated_reporter_cases_pkey" PRIMARY KEY ("id"),
    -- The signoff invariant, at the storage layer. `signed_off` is the only
    -- state that releases the parent incident for resolution, so it may not
    -- be reached without a recorded reviewer — a service-layer-only check
    -- would leave a direct UPDATE able to unblock an elder-abuse incident.
    CONSTRAINT "mandated_reporter_cases_signoff_attribution_check"
      CHECK (
        "status" <> 'signed_off'
        OR ("reviewer_user_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
      ),
    -- Four-eyes: the reviewer may not be the operator who opened the case.
    -- Cheap here, and it is the substance of "reviewer signoff" rather than
    -- a rubber stamp by the same person.
    CONSTRAINT "mandated_reporter_cases_reviewer_distinct_check"
      CHECK ("reviewer_user_id" IS NULL OR "reviewer_user_id" <> "opened_by_user_id"),
    -- A filing is evidenced by its timestamp; a reference without a filed_at
    -- (or vice versa) is a half-written record on a legal surface.
    CONSTRAINT "mandated_reporter_cases_filed_consistency_check"
      CHECK (
        ("filed_at" IS NULL AND "filing_reference" IS NULL)
        OR ("filed_at" IS NOT NULL)
      ),
    CONSTRAINT "mandated_reporter_cases_state_code_upper_check"
      CHECK ("state_code" = UPPER("state_code"))
);

-- One case per incident. Also what makes `openCase` idempotent under retry:
-- a duplicate open loses the race at the unique index rather than opening a
-- second statutory clock on the same facts.
CREATE UNIQUE INDEX "mandated_reporter_cases_incident_id_key"
    ON "trust_safety"."mandated_reporter_cases" ("incident_id");

CREATE INDEX "trust_safety_mandated_reporter_cases_status_idx"
    ON "trust_safety"."mandated_reporter_cases" ("status");

CREATE INDEX "trust_safety_mandated_reporter_cases_state_code_idx"
    ON "trust_safety"."mandated_reporter_cases" ("state_code");

-- Partial index over the live cases ordered by statutory deadline — the
-- "what is about to blow its window" sweep. Terminal (`signed_off`) and
-- deadline-less rows are excluded, so this index stays proportional to open
-- work rather than to history.
CREATE INDEX "mandated_reporter_cases_statutory_due_idx"
    ON "trust_safety"."mandated_reporter_cases" ("statutory_due_at")
    WHERE "status" <> 'signed_off' AND "statutory_due_at" IS NOT NULL;

-- FKs are within this service's own schema only (CLAUDE.md §2.3, §4.1).
-- RESTRICT on both: an incident with a live statutory case must not be
-- deletable out from under it, and a jurisdiction row must not vanish while
-- cases cite it.
ALTER TABLE "trust_safety"."mandated_reporter_cases"
    ADD CONSTRAINT "mandated_reporter_cases_incident_id_fkey"
    FOREIGN KEY ("incident_id") REFERENCES "trust_safety"."incidents"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "trust_safety"."mandated_reporter_cases"
    ADD CONSTRAINT "mandated_reporter_cases_state_code_fkey"
    FOREIGN KEY ("state_code") REFERENCES "trust_safety"."mandated_reporter_jurisdictions"("state_code")
    ON DELETE RESTRICT ON UPDATE CASCADE;
