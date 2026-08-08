# worker-analytics-aggregator

Nightly search-relevance aggregator worker. Implements **TS-217-prep-3b** (the
aggregation slice ahead of TS-217; PRD §10.1; PDD §5, §23.1, §23.2).

## What it does

Once per UTC day it triggers `service-analytics` to aggregate the **previous
complete UTC day's** raw `search.performed` + `booking.created` landing tables
(TS-217-prep-3a) into the search-relevance marts the TS-217 admin dashboard
renders. The worker holds **no datastore** — it makes a single
shared-secret-pinned internal call:

```
POST {ANALYTICS_SERVICE_BASE_URL}/api/v1/internal/analytics/search-relevance/compute
```

service-analytics owns the raw-table read + the aggregation. It writes three
`analytics`-schema marts (raw counts, not rates — the dashboard derives ratios):

| Mart                     | Grain               | Powers                                                                                                                                   |
| ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `search_relevance_daily` | one row / UTC day   | zero-result RATE (`zero_result_searches / total_searches`) + the approximate conversion funnel (`bookings_created / distinct_searchers`) |
| `search_query_daily`     | `(day, query_text)` | top queries + per-query zero-result                                                                                                      |
| `search_sort_daily`      | `(day, sort)`       | searches-per-sort                                                                                                                        |

Each run stamps one `analytics_aggregation_runs` row (`running` →
`succeeded`/`failed`). All search aggregations count **first-page** searches
(`search_events.page = 'first'`) so a deep-scroll pagination follow-up is not
double-counted.

**Conversion is approximate.** `booking.created` carries `householdId` but not
`actorUserId`, so the two raw tables share no join key in the interim. The
conversion funnel is a coarse platform-wide daily ratio, **not** per-search
attribution — precise attribution lands with TS-217-prep-4 (a search-correlation
id threaded through `booking.created`).

The compute is **idempotent**: re-running for the same date deletes + reinserts
that day's mart rows in one transaction. A same-day re-run with a fresh key
recomputes against current raw state.

## Previous-day targeting

Unlike `worker-accounting-metrics` — whose point-in-time snapshot targets
"now" / today — this worker aggregates a full UTC calendar DAY of events.
Running at 03:00 UTC for "today" would capture only the first three hours, so
the worker targets the **previous complete UTC day**: the in-process run guard
keys on today (one run per calendar day) while the work targets
`previousUtcDayKey(now)`, sent as an `asOf` of `<day>T00:00:00.000Z`.

## Scheduling

A `setTimeout` re-arming loop (`AggregationScheduler`) — the same idiom the
`accounting-metrics`, `outbox-relay`, `wellness-summary`, and `identity-janitor`
workers use — not BullMQ. The compute needs no job durability or retry
semantics (a missed run self-heals on the next tick, the date-keyed idempotency
makes a duplicate harmless), so the timer loop is the simpler, fleet-consistent
choice (CLAUDE.md §16). Each tick checks the run-hour window (UTC) against an
in-process last-run-day guard; the kill-switch (`ANALYTICS_AGGREGATOR_ENABLED`)
makes a tick a no-op without disarming the loop.

The worker sends a deterministic `Idempotency-Key`
(`search-relevance:compute:<YYYY-MM-DD>`): the analytics endpoint caches only a
SUCCESSFUL response, so a first attempt that failed before persisting is retried
by the next tick, while a crash-after-success replays the cached result.

## Configuration

| Env                                          | Default                        | Notes                                                                                                    |
| -------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `ANALYTICS_SERVICE_BASE_URL`                 | — (required)                   | base URL of service-analytics                                                                            |
| `ANALYTICS_AGGREGATION_INTERNAL_API_KEY`     | — (required, ≥32 chars)        | matches service-analytics' `INTERNAL_AGGREGATION_API_KEY`                                                |
| `ANALYTICS_AGGREGATION_INTERNAL_HEADER_NAME` | `x-analytics-internal-api-key` | header carrying the secret                                                                               |
| `ANALYTICS_AGGREGATOR_ENABLED`               | `true`                         | kill-switch                                                                                              |
| `ANALYTICS_AGGREGATOR_RUN_HOUR_UTC`          | `3`                            | nightly run hour (UTC) — after midnight closes the target day + after the 02:00 accounting-metrics sweep |
| `ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS`     | `3600000`                      | how often the scheduler wakes                                                                            |
| `REQUEST_TIMEOUT_MS`                         | `30000`                        | per-call timeout                                                                                         |
| `PORT`                                       | `3054`                         | `/healthz` + `/readyz` only                                                                              |

## Health

`/healthz` + `/readyz` both return ok once booted — the worker has no local
dependency whose health gates traffic, and a transient upstream blip should not
restart the pod (the next nightly tick recovers).

## Container image

Built from the canonical `infra/docker/nestjs.Dockerfile` (PDD §20.1 — no
per-service Dockerfile). The deployment + per-worker image-build workflow land
with the worker-fleet cluster rollout (TS-009g-followup-4).
