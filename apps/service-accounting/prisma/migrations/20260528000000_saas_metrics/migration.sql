-- TS-260 — nightly SaaS-metrics snapshot tables: saas_metrics_daily +
-- saas_subscription_mrr_daily.
--
-- Adds the derived read-model the `accounting-metrics` worker writes
-- nightly (PDD §8.2, §11.2, §23.2). Both tables are computed FROM the
-- existing `deferred_revenue_balances` ledger primitive — no existing
-- table is touched or repurposed.
--
-- saas_metrics_daily. One row per UTC calendar date carrying MRR / ARR /
-- ARPU / movement (new, expansion, contraction, churn) / net + gross
-- revenue retention. `metric_date` is UNIQUE — a recompute for the same
-- date replaces the row idempotently (the computation is deterministic
-- given ledger state). The unique index doubles as the time-series scan
-- index for the dashboard's "last N days" query (Postgres scans the
-- b-tree backwards for ORDER BY metric_date DESC).
--
-- saas_subscription_mrr_daily. The per-subscription MRR snapshot behind
-- the movement decomposition. It exists because the movement metrics
-- need each subscription's MRR AS IT WAS on the prior snapshot date —
-- `deferred_revenue_balances` only reflects CURRENT status, so a
-- subscription canceled between two runs would be misclassified if we
-- recomputed the prior day's coverage from current state. Persisting the
-- snapshot at compute time captures the historical truth. One row per
-- (metric_date, subscription_id); a recompute deletes the date's rows +
-- re-inserts.
--
-- Money discipline. Every monetary column is DECIMAL(12,2) — never a
-- float (CLAUDE.md §17.6). `net_new_mrr` is the only one that may go
-- negative (contraction + churn heavy day); no CHECK defends sign.
-- Retention ratios are DECIMAL(9,6) (e.g. 1.027100 = 102.71% NRR),
-- nullable when there is no prior baseline. `ltv` / `cac` are nullable
-- and NULL in Phase 1 — neither is derivable from the ledger alone
-- (TS-260-followup-1).
--
-- Cross-service references. `subscription_id` is a soft pointer into
-- `subscription.subscriptions.id` — cross-schema joins are forbidden
-- (CLAUDE.md §2.3, §4.1). No FK crosses the schema boundary.
--
-- Forward-compatible: expand-only — no existing column is repurposed.
--
-- Reversal plan:
--   DROP TABLE "accounting"."saas_subscription_mrr_daily";
--   DROP TABLE "accounting"."saas_metrics_daily";
-- Safe in isolation — no other table references these shapes.

-- CreateTable — one daily metrics snapshot per UTC calendar date.
CREATE TABLE "accounting"."saas_metrics_daily" (
  "id"                        TEXT            NOT NULL,
  "metric_date"               DATE            NOT NULL,
  "currency"                  CHAR(3)         NOT NULL DEFAULT 'USD',
  "mrr"                       DECIMAL(12,2)   NOT NULL,
  "arr"                       DECIMAL(12,2)   NOT NULL,
  "arpu"                      DECIMAL(12,2)   NOT NULL,
  "active_subscriptions"      INTEGER         NOT NULL,
  "new_mrr"                   DECIMAL(12,2)   NOT NULL,
  "expansion_mrr"             DECIMAL(12,2)   NOT NULL,
  "contraction_mrr"           DECIMAL(12,2)   NOT NULL,
  "churned_mrr"               DECIMAL(12,2)   NOT NULL,
  "churned_subscriptions"     INTEGER         NOT NULL,
  "net_new_mrr"               DECIMAL(12,2)   NOT NULL,
  "prior_mrr"                 DECIMAL(12,2)   NOT NULL,
  "net_revenue_retention"     DECIMAL(9,6),
  "gross_revenue_retention"   DECIMAL(9,6),
  "ltv"                       DECIMAL(12,2),
  "cac"                       DECIMAL(12,2),
  "comparison_date"           DATE,
  "computed_at"               TIMESTAMPTZ(6)  NOT NULL,
  "created_at"                TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMPTZ(6)  NOT NULL,

  CONSTRAINT "saas_metrics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one snapshot per day. Doubles as the time-series scan
-- index for the dashboard's ORDER BY metric_date DESC LIMIT N query.
CREATE UNIQUE INDEX "saas_metrics_daily_metric_date_unique"
  ON "accounting"."saas_metrics_daily"("metric_date");

-- CreateTable — per-(date, subscription) MRR snapshot behind the
-- movement decomposition.
CREATE TABLE "accounting"."saas_subscription_mrr_daily" (
  "id"               TEXT            NOT NULL,
  "metric_date"      DATE            NOT NULL,
  "subscription_id"  TEXT            NOT NULL,
  "customer_group"   "accounting"."deferred_revenue_customer_group" NOT NULL,
  "plan_code"        TEXT            NOT NULL,
  "mrr"              DECIMAL(12,2)   NOT NULL,
  "currency"         CHAR(3)         NOT NULL DEFAULT 'USD',
  "created_at"       TIMESTAMPTZ(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "saas_subscription_mrr_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — one row per (date, subscription). The per-date prefix
-- serves both the delete-by-date (recompute) and the "load the prior
-- snapshot date's rows" reads.
CREATE UNIQUE INDEX "saas_subscription_mrr_daily_date_subscription_unique"
  ON "accounting"."saas_subscription_mrr_daily"("metric_date", "subscription_id");
