# worker-accounting-metrics

Nightly SaaS-metrics worker. Implements **TS-260** (PRD §10.3; PDD §11.2,
§23.2).

## What it does

Once per UTC day it triggers `service-accounting` to compute the daily
SaaS-metrics snapshot and persist it to `accounting.saas_metrics_daily`.
The worker holds **no datastore** — it makes a single shared-secret-pinned
internal call:

```
POST {ACCOUNTING_SERVICE_BASE_URL}/api/v1/internal/accounting/saas-metrics/compute
```

The accounting service owns the read + the money math. It computes from
**ledger primitives** — the `deferred_revenue_balances` rows the
revenue-recognition driver (TS-082) maintains — never by reaching across
the schema boundary into `subscription.subscriptions` (CLAUDE.md §2.3):

| Metric                                | Derivation                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| MRR                                   | Σ monthly-normalised face value of active balances whose service period covers the metric date |
| ARR                                   | MRR × 12                                                                                       |
| ARPU                                  | MRR ÷ active subscriptions                                                                     |
| new / expansion / contraction / churn | per-subscription MRR today vs. the prior snapshot (`saas_subscription_mrr_daily`)              |
| NRR / GRR                             | `(prior ± movement) / prior`, null when there is no prior baseline                             |
| LTV / CAC                             | **null in Phase 1** — not derivable from the ledger alone (TS-260-followup-1)                  |

The compute is **idempotent**: re-running for the same date replaces the
day's metrics row + per-subscription snapshot. A same-day re-run with a
fresh key recomputes against current ledger state.

## Scheduling

A `setTimeout` re-arming loop (`MetricsScheduler`) — the same idiom the
`outbox-relay`, `wellness-summary`, and `identity-janitor` workers use —
not BullMQ. TS-260's acceptance named a "BullMQ scheduled worker"; because
the compute needs no job durability or retry semantics (a missed run
self-heals on the next tick, and the date-keyed idempotency makes a
duplicate harmless), the timer loop is the simpler, fleet-consistent
choice (CLAUDE.md §16 — trade-off documented). Promote to a BullMQ
repeatable job if a future requirement needs durable cross-replica
scheduling.

Each tick checks the run-hour window (UTC) against an in-process
last-run-day guard; the kill-switch (`ACCOUNTING_METRICS_ENABLED`) makes a
tick a no-op without disarming the loop.

The worker sends a deterministic `Idempotency-Key`
(`saas-metrics:compute:<YYYY-MM-DD>`): the accounting endpoint caches only
a SUCCESSFUL response, so a first attempt that failed before persisting is
retried by the next tick, while a crash-after-success replays the cached
result.

## Configuration

| Env                                            | Default                         | Notes                                                                |
| ---------------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| `ACCOUNTING_SERVICE_BASE_URL`                  | — (required)                    | base URL of service-accounting                                       |
| `ACCOUNTING_SAAS_METRICS_INTERNAL_API_KEY`     | — (required, ≥32 chars)         | matches service-accounting's `INTERNAL_POST_JOURNAL_API_KEY`         |
| `ACCOUNTING_SAAS_METRICS_INTERNAL_HEADER_NAME` | `x-accounting-internal-api-key` | header carrying the secret                                           |
| `ACCOUNTING_METRICS_ENABLED`                   | `true`                          | kill-switch                                                          |
| `ACCOUNTING_METRICS_RUN_HOUR_UTC`              | `2`                             | nightly run hour (UTC) — after the revenue-recognition sweep settles |
| `ACCOUNTING_METRICS_SCHEDULER_TICK_MS`         | `3600000`                       | how often the scheduler wakes                                        |
| `REQUEST_TIMEOUT_MS`                           | `30000`                         | per-call timeout                                                     |
| `PORT`                                         | `3053`                          | `/healthz` + `/readyz` only                                          |

## Health

`/healthz` + `/readyz` both return ok once booted — the worker has no
local dependency whose health gates traffic, and a transient upstream blip
should not restart the pod (the next nightly tick recovers).
