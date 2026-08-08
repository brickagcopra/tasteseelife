-- TS-073 — Notification channel dispatchers + preferences + quiet hours.
--
-- Adds the per-`(user, channel, category)` preference table, the per-
-- user preference-profile table (quiet hours + senior_mode + IANA time
-- zone + globally-unsubscribed flag), and the per-dispatch row table
-- that records every call to the dispatch orchestrator regardless of
-- outcome (sent / failed / suppressed_*).
--
-- Three new enums:
--   - notification_category            (transactional / marketing / system)
--   - notification_dispatch_status     (queued / sent / failed / suppressed_*)
--   - notification_suppression_reason  (preference_opted_out / quiet_hours / ...)
--
-- DB-CHECK invariants:
--   - dispatch row per-status invariants (sent → provider_message_id NOT
--     NULL; failed → error_message NOT NULL; suppressed_* →
--     suppression_reason NOT NULL; queued → all of the above null).
--   - quiet-hours window invariants (both columns set or both null +
--     time_zone NOT NULL when set + start != end).
--
-- Reversal plan (drop in reverse-dependency order):
--   DROP TABLE "notification"."notification_dispatches";
--   DROP TABLE "notification"."notification_user_preference_profiles";
--   DROP TABLE "notification"."notification_preferences";
--   DROP TYPE  "notification"."notification_suppression_reason";
--   DROP TYPE  "notification"."notification_dispatch_status";
--   DROP TYPE  "notification"."notification_category";
-- Safe in isolation because the new tables don't reference existing
-- service tables (cross-service references are by id only — CLAUDE.md
-- §2.3).

-- CreateEnum: notification_category
CREATE TYPE "notification"."notification_category" AS ENUM (
  'transactional',
  'marketing',
  'system'
);

-- CreateEnum: notification_dispatch_status
CREATE TYPE "notification"."notification_dispatch_status" AS ENUM (
  'queued',
  'sent',
  'failed',
  'suppressed_by_preference',
  'suppressed_by_quiet_hours',
  'suppressed_by_unsubscribed'
);

-- CreateEnum: notification_suppression_reason
CREATE TYPE "notification"."notification_suppression_reason" AS ENUM (
  'preference_opted_out',
  'quiet_hours',
  'globally_unsubscribed',
  'recipient_address_missing'
);

-- CreateTable: notification_preferences
CREATE TABLE "notification"."notification_preferences" (
  "user_id"     TEXT                                          NOT NULL,
  "channel"     "notification"."notification_channel_kind"    NOT NULL,
  "category"    "notification"."notification_category"        NOT NULL,
  "opt_in"      BOOLEAN                                       NOT NULL,
  "created_at"  TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "notification_preferences_pkey"
    PRIMARY KEY ("user_id", "channel", "category")
);

-- CreateIndex: per-user fan-out (driving the "GET preferences for user"
-- read path; the composite PK already covers the (user, channel,
-- category) lookup, but a sole-user lookup needs its own index because
-- the leading column is enough but ordering matters for EXPLAIN).
CREATE INDEX "notification_preferences_user_idx"
  ON "notification"."notification_preferences"("user_id");

-- CreateTable: notification_user_preference_profiles
CREATE TABLE "notification"."notification_user_preference_profiles" (
  "user_id"                   TEXT             NOT NULL,
  "quiet_hours_start_minute"  INTEGER,
  "quiet_hours_end_minute"    INTEGER,
  "time_zone"                 TEXT,
  "senior_mode"               BOOLEAN          NOT NULL DEFAULT FALSE,
  "globally_unsubscribed"     BOOLEAN          NOT NULL DEFAULT FALSE,
  "created_at"                TIMESTAMPTZ(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(6)   NOT NULL,

  CONSTRAINT "notification_user_preference_profiles_pkey" PRIMARY KEY ("user_id")
);

-- CHECK: quiet-hours window invariants.
--   - either both minute columns are NULL (no window) OR both are set;
--   - when set, time_zone must be NOT NULL (the window is local-time);
--   - when set, start != end (zero-width window rejected at contract +
--     here as defence-in-depth);
--   - minutes bounded to [0, 1439].
ALTER TABLE "notification"."notification_user_preference_profiles"
  ADD CONSTRAINT "notification_user_preference_profiles_quiet_hours_check" CHECK (
    (
      "quiet_hours_start_minute" IS NULL
      AND "quiet_hours_end_minute" IS NULL
    )
    OR (
      "quiet_hours_start_minute" IS NOT NULL
      AND "quiet_hours_end_minute" IS NOT NULL
      AND "time_zone" IS NOT NULL
      AND "quiet_hours_start_minute" >= 0
      AND "quiet_hours_start_minute" <= 1439
      AND "quiet_hours_end_minute" >= 0
      AND "quiet_hours_end_minute" <= 1439
      AND "quiet_hours_start_minute" <> "quiet_hours_end_minute"
    )
  );

-- CreateTable: notification_dispatches
CREATE TABLE "notification"."notification_dispatches" (
  "id"                    TEXT                                                  NOT NULL,
  "recipient_user_id"     TEXT                                                  NOT NULL,
  "channel"               "notification"."notification_channel_kind"            NOT NULL,
  "category"              "notification"."notification_category"                NOT NULL,
  "template_code"         TEXT                                                  NOT NULL,
  "locale"                "notification"."notification_locale"                  NOT NULL,
  "template_id"           TEXT,
  "template_version_id"   TEXT,
  "recipient_address"     TEXT                                                  NOT NULL,
  "status"                "notification"."notification_dispatch_status"         NOT NULL,
  "suppression_reason"    "notification"."notification_suppression_reason",
  "provider_message_id"   TEXT,
  "error_message"         TEXT,
  "idempotency_key"       TEXT                                                  NOT NULL,
  "source_event_id"       TEXT,
  "bypass_quiet_hours"    BOOLEAN                                               NOT NULL DEFAULT FALSE,
  "occurred_at"           TIMESTAMPTZ(6)                                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at"               TIMESTAMPTZ(6),

  CONSTRAINT "notification_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: idempotency-key UNIQUE — drives the orchestrator dedup
-- path. P2002 surfaces as a replay-of-existing-row at the service layer.
CREATE UNIQUE INDEX "notification_dispatches_idempotency_key_uniq"
  ON "notification"."notification_dispatches"("idempotency_key");

-- CreateIndex: (recipient_user_id, occurred_at DESC) — drives the
-- "show this user's recent notifications" admin read path.
CREATE INDEX "notification_dispatches_recipient_occurred_idx"
  ON "notification"."notification_dispatches"("recipient_user_id", "occurred_at" DESC);

-- CreateIndex: (status, occurred_at DESC) — drives ops alerts on the
-- failed/queued backlog.
CREATE INDEX "notification_dispatches_status_occurred_idx"
  ON "notification"."notification_dispatches"("status", "occurred_at" DESC);

-- CreateIndex: (channel, category, occurred_at DESC) — drives the
-- channel/category breakdown in the admin dashboard.
CREATE INDEX "notification_dispatches_channel_category_idx"
  ON "notification"."notification_dispatches"("channel", "category", "occurred_at" DESC);

-- CHECK: per-status invariants. The four disjoint branches cover every
-- documented value of `notification_dispatch_status`; a service-layer
-- regression that landed (say) a `sent` row without a provider message
-- id would hit SQLSTATE 23514.
ALTER TABLE "notification"."notification_dispatches"
  ADD CONSTRAINT "notification_dispatches_status_invariants_check" CHECK (
    (
      "status" = 'queued'
      AND "suppression_reason" IS NULL
      AND "provider_message_id" IS NULL
      AND "error_message" IS NULL
      AND "sent_at" IS NULL
    )
    OR (
      "status" = 'sent'
      AND "suppression_reason" IS NULL
      AND "provider_message_id" IS NOT NULL
      AND "error_message" IS NULL
      AND "sent_at" IS NOT NULL
    )
    OR (
      "status" = 'failed'
      AND "suppression_reason" IS NULL
      AND "provider_message_id" IS NULL
      AND "error_message" IS NOT NULL
      AND "sent_at" IS NULL
    )
    OR (
      "status" IN ('suppressed_by_preference', 'suppressed_by_quiet_hours', 'suppressed_by_unsubscribed')
      AND "suppression_reason" IS NOT NULL
      AND "provider_message_id" IS NULL
      AND "error_message" IS NULL
      AND "sent_at" IS NULL
    )
  );
