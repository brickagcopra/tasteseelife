-- TS-307a — `source_event_id` on `incidents`: the domain-level idempotency
-- guard for event-sourced incidents.
--
-- Expand-only (CLAUDE.md §4.1): adds a nullable column plus a partial UNIQUE
-- index. No existing row is touched and no read path changes.
--
-- Why it has to exist before the first consumer handler ships. The outbox
-- consumer SDK's `trust_safety.outbox_consumer_dedup` table already stops a
-- redelivery, but it is a CACHE of processing decisions, not a constraint on
-- the thing that matters. If that table is ever truncated, restored from an
-- older snapshot, or the consumer group is recreated with a new name, every
-- event replays — and for this consumer a replay means a duplicate incident:
-- a second SLA clock, a second row in the operator queue, and (for a
-- `high`/`critical` grade) a second booking hold and a second page to
-- on-call. The dedup table is the fast path; this index is the one that is
-- still true after an operational accident.
--
-- Nullable, and the UNIQUE is PARTIAL, because most incidents have no source
-- event: every human-filed report (TS-301a family/senior, TS-301b provider,
-- the concierge on-behalf path) arrives over HTTP with nothing to key on. A
-- non-partial UNIQUE would collapse all of them onto a single NULL in some
-- engines and, more importantly, would misrepresent the invariant — which is
-- "at most one incident per source event", not "every incident has one".
--
-- The value is the outbox envelope's `event_id`, which producers derive
-- deterministically from the state change (see TS-307a's
-- `{backgroundCheckId}.adverse.{checkrEventId}`), so the same real-world
-- finding always yields the same key no matter how many times it is
-- delivered.
--
-- This column was foreshadowed by TS-302a's module doc-block as landing with
-- TS-302d. TS-302d is still blocked on the USER-BLOCKED TS-302c publisher
-- decision; TS-307a needs the same guard, so it lands here instead. TS-302d
-- should consume it rather than adding a second one.
--
--   EXPLAIN: the lookup is an equality probe on a unique key during insert
--   conflict detection, not a query path — a btree UNIQUE is exactly right.
--   The partial predicate keeps the index sized to event-sourced incidents
--   only, which will be a small minority of the table for the foreseeable
--   future.
--
-- Reversal plan:
--   DROP INDEX "trust_safety"."trust_safety_incidents_source_event_id_key";
--   ALTER TABLE "trust_safety"."incidents" DROP COLUMN "source_event_id";

ALTER TABLE "trust_safety"."incidents" ADD COLUMN "source_event_id" TEXT;

CREATE UNIQUE INDEX "trust_safety_incidents_source_event_id_key"
  ON "trust_safety"."incidents" ("source_event_id")
  WHERE "source_event_id" IS NOT NULL;
