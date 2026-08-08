-- TS-072 — initial notification schema.
--
-- Creates the `notification` Postgres schema, the two enums
-- (`notification_channel_kind`, `notification_locale`), the
-- `notification_templates` registry table, the
-- `notification_template_versions` immutable content blob, the
-- soft-FK relationships (active version pointer + cascade-on-template-
-- delete for versions), and the per-kind CHECK constraints that enforce
-- the body-shape rules at the row level (defence-in-depth alongside
-- the service-layer Renderer).
--
-- Append-only enforcement on versions lands as TS-072-followup-11 —
-- the trigger pair mirrors the audit_events shape. Today the service
-- layer is the only writer and it never updates a version row.
--
-- Reversal plan:
--   DROP TABLE "notification"."notification_template_versions";
--   DROP TABLE "notification"."notification_templates";
--   DROP TYPE  "notification"."notification_locale";
--   DROP TYPE  "notification"."notification_channel_kind";
--   DROP SCHEMA "notification";
-- Safe in isolation because no other service schema references these
-- objects (cross-service references are by id only — CLAUDE.md §2.3).

CREATE SCHEMA IF NOT EXISTS "notification";

-- CreateEnum
CREATE TYPE "notification"."notification_channel_kind" AS ENUM (
  'email',
  'sms',
  'push',
  'in_app'
);

CREATE TYPE "notification"."notification_locale" AS ENUM (
  'en_US',
  'es_US',
  'zh_CN'
);

-- CreateTable: notification_templates
CREATE TABLE "notification"."notification_templates" (
  "id"                  TEXT                                          NOT NULL,
  "code"                TEXT                                          NOT NULL,
  "locale"              "notification"."notification_locale"          NOT NULL,
  "kind"                "notification"."notification_channel_kind"    NOT NULL,
  "name"                TEXT                                          NOT NULL,
  "description"         TEXT,
  "active_version_id"   TEXT,
  "created_by_user_id"  TEXT                                          NOT NULL,
  "created_at"          TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)                                NOT NULL,

  CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: notification_template_versions
CREATE TABLE "notification"."notification_template_versions" (
  "id"                  TEXT                                          NOT NULL,
  "template_id"         TEXT                                          NOT NULL,
  "kind"                "notification"."notification_channel_kind"    NOT NULL,
  "version"             INTEGER                                       NOT NULL,
  "subject"             TEXT,
  "body_mjml"           TEXT,
  "body_html"           TEXT,
  "body_text"           TEXT,
  "variables_schema"    JSONB                                         NOT NULL,
  "change_summary"      TEXT,
  "created_by_user_id"  TEXT                                          NOT NULL,
  "created_at"          TIMESTAMPTZ(6)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "notification_template_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: templates UNIQUE on (code, locale)
-- Drives the renderer's primary lookup. A re-submission with the same
-- (code, locale) returns 409 Conflict at the service layer (P2002).
CREATE UNIQUE INDEX "notification_templates_code_locale_key"
  ON "notification"."notification_templates"("code", "locale");

-- CreateIndex: templates (kind, code) — admin filter
CREATE INDEX "notification_templates_kind_code_idx"
  ON "notification"."notification_templates"("kind", "code");

-- CreateIndex: versions UNIQUE on (template_id, version) — monotonic
-- per template; serialises concurrent INSERTs through P2002.
CREATE UNIQUE INDEX "notification_template_versions_template_version_key"
  ON "notification"."notification_template_versions"("template_id", "version");

-- CreateIndex: versions (template_id, version DESC) — drives the
-- "list all versions for this template, newest first" admin view.
CREATE INDEX "notification_template_versions_template_version_desc_idx"
  ON "notification"."notification_template_versions"("template_id", "version" DESC);

-- AddForeignKey: versions.template_id → templates.id, cascade-on-delete
-- so deleting a template (admin garbage-collection of an unactivated
-- template, never an active one) cleans up its version history.
ALTER TABLE "notification"."notification_template_versions"
  ADD CONSTRAINT "notification_template_versions_template_id_fkey"
  FOREIGN KEY ("template_id")
  REFERENCES "notification"."notification_templates"("id")
  ON DELETE CASCADE
  ON UPDATE NO ACTION;

-- AddForeignKey: templates.active_version_id → versions.id, SET NULL
-- on delete so a cascaded version delete (above) doesn't violate FK.
-- The two FKs together form a cycle (template ↔ version); Postgres
-- handles it because both are deferred-evaluable at COMMIT time within
-- the same transaction.
ALTER TABLE "notification"."notification_templates"
  ADD CONSTRAINT "notification_templates_active_version_id_fkey"
  FOREIGN KEY ("active_version_id")
  REFERENCES "notification"."notification_template_versions"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;

-- CHECK: per-kind body shape (defence-in-depth alongside service layer).
--
--   - email:  subject NOT NULL AND (body_mjml NOT NULL OR body_html NOT NULL)
--   - sms:    body_text NOT NULL AND subject IS NULL AND body_mjml IS NULL AND body_html IS NULL
--   - push:   body_text NOT NULL AND body_mjml IS NULL AND body_html IS NULL
--             (subject is the optional notification title)
--   - in_app: body_text NOT NULL AND body_mjml IS NULL AND body_html IS NULL
--             (subject is optional)
--
-- A service-layer regression that lands a bad row hits a SQLSTATE
-- 23514; the migration's reversal plan covers undo if the rules need
-- to evolve. The check is intentionally tight so an "any field
-- populated" misuse surfaces immediately.
ALTER TABLE "notification"."notification_template_versions"
  ADD CONSTRAINT "notification_template_versions_body_shape_check" CHECK (
    (
      "kind" = 'email'
      AND "subject" IS NOT NULL
      AND ("body_mjml" IS NOT NULL OR "body_html" IS NOT NULL)
    )
    OR (
      "kind" = 'sms'
      AND "body_text" IS NOT NULL
      AND "subject" IS NULL
      AND "body_mjml" IS NULL
      AND "body_html" IS NULL
    )
    OR (
      "kind" = 'push'
      AND "body_text" IS NOT NULL
      AND "body_mjml" IS NULL
      AND "body_html" IS NULL
    )
    OR (
      "kind" = 'in_app'
      AND "body_text" IS NOT NULL
      AND "body_mjml" IS NULL
      AND "body_html" IS NULL
    )
  );

-- CHECK: version is monotonic positive integer per template (UNIQUE
-- index above enforces uniqueness; this guards the lower bound).
ALTER TABLE "notification"."notification_template_versions"
  ADD CONSTRAINT "notification_template_versions_version_positive_check"
  CHECK ("version" >= 1);
