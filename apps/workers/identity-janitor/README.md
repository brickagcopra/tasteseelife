# worker-identity-janitor

Periodic retention pruner for the `identity` schema. Implements
**TS-022-followup-3** (refresh-token janitor) and **TS-023-followup-4**
(`mfa_challenges` janitor).

## What it does

Two `identity`-schema tables grow append-mostly under sustained auth
traffic and never shrink on their own:

| Table                     | Why it grows                                                                            | Pruned when                                         |
| ------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `identity.refresh_tokens` | one row per issued session token; rotation + expiry leave dead rows                     | `expires_at < now() - REFRESH_TOKEN_RETENTION_DAYS` |
| `identity.mfa_challenges` | one row per MFA-enabled login attempt; consumed/expired challenges are never cleaned up | `expires_at < now() - MFA_CHALLENGE_RETENTION_DAYS` |

Both tables carry an index on `expires_at`
(`refresh_tokens_expires_at_idx` / `mfa_challenges_expires_at_idx`), so
the retention range scan is cheap regardless of table size.

Deletes run in **bounded batches** (`DELETE … WHERE id IN (SELECT id …
LIMIT n)`) so each statement's lock footprint + WAL volume stays flat —
a neglected table with a large backlog can't stall replication or block
concurrent auth writes. The remainder of an oversized backlog is
deferred to the next sweep.

The prune is **idempotent** and **absolute-time-threshold based**
(`now() - interval`), so a missed or duplicated sweep is harmless — the
next sweep simply re-evaluates eligibility.

## Why 30 days past expiry (not 0)

An expired refresh-token row is still an audit artefact — it records the
session's IP / UA / family lineage. Deleting it the instant it expires
would erase a forensic trail exactly when it becomes useful for a
"who logged in from where" investigation. The 30-day default keeps the
recent trail intact while still bounding table growth (CLAUDE.md §3.6).
Both windows are operator-tunable.

## Scheduling

A `setTimeout` re-arming loop (`JanitorScheduler`) — the same idiom the
`outbox-relay` and `wellness-summary` workers use — not BullMQ.
TS-022-followup-3 named a "BullMQ scheduled worker **or equivalent**";
because the prune needs no job durability or retry semantics (a missed
run self-heals), the timer loop is the simpler, fleet-consistent choice.
If a future requirement needs durable scheduling (e.g. exactly-once
cross-replica coordination), promote to a BullMQ repeatable job then.

## Database access

The worker connects to the identity database with raw `pg` — it never
imports `service-identity`'s Prisma client (CLAUDE.md §2.3) — and only
ever touches the fixed **code-constant** target tables in
`src/janitor/prune-targets.ts`. The schema/table/column identifiers are
never sourced from env or any request, so the interpolated SQL carries
no injection surface; a defence-in-depth identifier regex guards against
a careless future edit. This mirrors the `outbox-relay`'s posture: a
platform retention/maintenance process scoped to one known schema, not
cross-service business logic.

## Configuration

| Env var                         | Default        | Notes                                                                          |
| ------------------------------- | -------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`                  | — (required)   | Identity Postgres connection string                                            |
| `JANITOR_ENABLED`               | `true`         | Global kill-switch; scheduler keeps ticking but every tick is a no-op when off |
| `JANITOR_INTERVAL_MS`           | `3600000` (1h) | Sweep cadence; min 60s                                                         |
| `JANITOR_BATCH_SIZE`            | `5000`         | Rows per `DELETE`; max 50000                                                   |
| `JANITOR_MAX_BATCHES_PER_SWEEP` | `1000`         | Batch cap per target per sweep                                                 |
| `REFRESH_TOKEN_RETENTION_DAYS`  | `30`           | Days past `expires_at` before deletion                                         |
| `REFRESH_TOKEN_PRUNE_ENABLED`   | `true`         | Per-table enable flag                                                          |
| `MFA_CHALLENGE_RETENTION_DAYS`  | `30`           | Days past `expires_at` before deletion                                         |
| `MFA_CHALLENGE_PRUNE_ENABLED`   | `true`         | Per-table enable flag                                                          |
| `PORT`                          | `3051`         | `/healthz` + `/readyz` only                                                    |
| `LOG_LEVEL`                     | `info`         |                                                                                |

## Health

- `GET /healthz` — liveness, unconditional 200.
- `GET /readyz` — readiness, `SELECT 1` against Postgres (no Redis dep).

## Observability (TS-022-followup-3a)

Tracing + metrics mirror the `service-identity` shape (TS-020-followup-1):
the OTel SDK is booted in `src/observability/bootstrap.ts`, imported as the
first line of `main.ts` so `@opentelemetry/auto-instrumentations-node`
patches `pg`/`http` before any module loads.

- **Traces** — each sweep runs inside an `identity_janitor.sweep` span; each
  target's prune nests under it as an `identity_janitor.prune` span carrying
  an `identity_janitor.table` attribute (+ rows-deleted / batches /
  capped-out on completion).
- **Metrics** — `GET /metrics` exposes the Prometheus exposition document
  (unconditionally — returns the empty document when `OTEL_METRICS_ENABLED`
  is `false` so Prometheus doesn't alarm on a missing target):

  | Metric                                    | Type      | Labels  |
  | ----------------------------------------- | --------- | ------- |
  | `identity_janitor_rows_deleted_total`     | counter   | `table` |
  | `identity_janitor_sweep_errors_total`     | counter   | `table` |
  | `identity_janitor_sweep_duration_seconds` | histogram | —       |

  No HTTP-request interceptor is wired (unlike service-identity): the only
  HTTP surface is the probes + this scrape route, so per-request counters
  carry no signal.

| Env var                       | Default | Notes                                              |
| ----------------------------- | ------- | -------------------------------------------------- |
| `OTEL_TRACES_ENABLED`         | `true`  | Flip `false` to short-circuit `initTracing`        |
| `OTEL_METRICS_ENABLED`        | `true`  | `/metrics` stays wired; returns empty doc when off |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | —       | Optional explicit OTLP/HTTP endpoint override      |

## Testing

- **Unit** (`pnpm test`) — drives the batch loop against a fake executor
  (`src/janitor/prune.repository.test.ts`); pure-Node, no Docker.
- **Integration** (`pnpm test:integration`, TS-022-followup-3b) — boots
  an ephemeral Postgres-16 container via `@taste-and-see/testing`,
  creates the two `identity`-schema tables (minimal `id` + `expires_at`
  projection — the worker connects with raw `pg` and never imports
  service-identity's Prisma client, CLAUDE.md §2.3), seeds rows
  straddling the retention window, and runs the real `PgPruneExecutor` +
  `PruneRepository` + `JanitorWorkerService` against them. Asserts only
  retention-aged rows are deleted, the batch loop drains a >batch
  backlog, and the per-sweep cap defers the remainder. Runs in CI under
  the root `integration-test` job.

## Follow-ups (not in scope here)

- Kubernetes Deployment manifest + image build workflow (mirror the
  outbox-relay's `infra/` wiring) when the worker is rolled into the
  cluster (TS-022-followup-3c).
