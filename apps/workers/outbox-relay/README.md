# worker-outbox-relay

Outbox relay worker for the Taste & See platform (TS-142).

A long-running process that polls each producer service's
`{schema}.outbox_events` table for undispatched rows and forwards them
onto Redis Streams. Consumers subscribe via `XREADGROUP` and dedupe
on `event_id`.

Implements the outbox pattern from **PDD §7.3** + **CLAUDE.md §5.3**.

## Architecture

```
service-subscription                service-booking                  service-...
        │                                  │                              │
        │ tx { state-change + outbox.append }
        ▼                                  ▼                              ▼
┌───────────────────────┐         ┌─────────────────────┐       ┌─────────────────────┐
│ subscription          │         │ booking             │       │ ...                 │
│ .outbox_events        │         │ .outbox_events      │       │ .outbox_events      │
└───────────────────────┘         └─────────────────────┘       └─────────────────────┘
        │                                  │                              │
        └─────────────┐                    │                              │
                      │                    │       ┌──────────────────────┘
                      ▼                    ▼       ▼
              ┌──────────────────────────────────────────────┐
              │              worker-outbox-relay             │
              │  pollOnce() → claimBatch → publish → mark    │
              └──────────────────────────────────────────────┘
                              │
                              ▼ XADD MAXLEN ~ N
              ┌──────────────────────────────────────────────┐
              │  Redis Streams                                │
              │  events:subscription.activated                │
              │  events:booking.completed                     │
              │  events:...                                   │
              └──────────────────────────────────────────────┘
                              │
                              ▼ XREADGROUP
              ┌──────────────────────────────────────────────┐
              │  Downstream consumers (Phase 2+):             │
              │  - service-accounting  (revenue recognition)  │
              │  - service-notification (email/SMS/push)      │
              │  - service-analytics                          │
              │  - service-audit                              │
              └──────────────────────────────────────────────┘
```

## Configuration

| Variable                      | Default       | Notes                                                                |
| ----------------------------- | ------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`                | _required_    | Postgres connection — Phase 1 single DB hosting all service schemas. |
| `REDIS_URL`                   | _required_    | Redis Streams bus.                                                   |
| `OUTBOX_SOURCES`              | _required_    | Comma-separated `schema.table` pairs.                                |
| `POLL_INTERVAL_MS`            | `1000`        | Cycle interval.                                                      |
| `BATCH_SIZE`                  | `100`         | Max rows claimed per source per cycle.                               |
| `MAX_ATTEMPTS`                | `10`          | Dead-letter cap.                                                     |
| `STREAM_MAXLEN`               | `100000`      | `XADD MAXLEN ~ N` bound per stream.                                  |
| `STREAM_NAME_PREFIX`          | `events`      | Stream-key prefix (final key: `{prefix}:{event_name}`).              |
| `PORT`                        | `3050`        | Health-probe + `/metrics` scrape HTTP port.                          |
| `LOG_LEVEL`                   | `info`        |                                                                      |
| `NODE_ENV`                    | `development` |                                                                      |
| `SERVICE_VERSION`             | `dev`         |                                                                      |
| `OTEL_TRACES_ENABLED`         | `true`        | Flip `false` to short-circuit `initTracing`.                         |
| `OTEL_METRICS_ENABLED`        | `true`        | Flip `false` to short-circuit `initMetrics` (scrape route stays up). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | _optional_    | OTLP/HTTP span endpoint override.                                    |

Example:

```bash
DATABASE_URL=postgresql://taste:secret@localhost:5432/taste \
REDIS_URL=redis://localhost:6379/0 \
OUTBOX_SOURCES=subscription.outbox_events,provider.outbox_events,identity.outbox_events,household.outbox_events,booking.outbox_events,accounting.outbox_events,webhook.outbox_events,search.outbox_events \
POLL_INTERVAL_MS=500 \
BATCH_SIZE=200 \
pnpm -F @taste-and-see/worker-outbox-relay start
```

## Failure model

- **Postgres down**: `claimBatch` errors are logged + skipped for the
  cycle; the relay retries on the next tick. No state mutation.
- **Redis down**: each `publish` errors → `recordFailure` increments
  `attempts` + writes `last_error`. The row stays in the queue.
  Once `attempts == MAX_ATTEMPTS` the row is dead-lettered (the
  `claimBatch` query filters it out) — ops attention required.
- **Publish succeeded but markDispatched failed**: the row gets
  re-claimed on the next cycle and republished. Consumers dedupe on
  `event_id`. At-least-once delivery, as designed.

## Wire format

Each stream entry carries the key-value pairs:

```
event_id          → the dedup key
event_name        → for fan-out / routing
payload           → JSON-stringified domain payload
occurred_at       → producer wall-clock ISO 8601
producer_service  → originating service name
schema            → originating Postgres schema
```

Stream keys are `{STREAM_NAME_PREFIX}:{event_name}` — one stream per
event name. Consumers subscribe to specific events without parsing
payloads they don't care about.

## Health probes

- `GET /healthz` — liveness; always 200.
- `GET /readyz` — readiness; pings Postgres + Redis; 503 if either
  is unreachable.

## Observability (TS-142-followup-4)

OpenTelemetry tracing + Prometheus metrics are booted as the first
import in `main.ts` (`src/observability/bootstrap.ts`), before `pg` /
`ioredis` / `http` are required, so the auto-instrumentation patches
them. The relay's own spans nest under those auto-spans:

- `outbox_relay.poll` — one per `pollOnce()` cycle.
- `outbox_relay.poll_source` — one per configured source (`source` attr).
- `outbox_relay.dispatch_row` — one per row publish (`event_name` attr).

The Prometheus scrape endpoint is `GET /metrics` (text exposition),
mounted via `@taste-and-see/nest-observability` with `httpMetrics: false`
(a worker has no per-request HTTP signal). Domain instruments
(`src/relay/relay-metrics.ts`):

| Metric                                  | Type      | Labels                               |
| --------------------------------------- | --------- | ------------------------------------ |
| `outbox_relay_polls_total`              | counter   | `source`, `outcome=ok\|claim_failed` |
| `outbox_relay_rows_dispatched_total`    | counter   | `source`, `event_name`               |
| `outbox_relay_rows_failed_total`        | counter   | `source`, `event_name`, `reason`     |
| `outbox_relay_rows_dead_lettered_total` | counter   | `source`, `event_name`               |
| `outbox_relay_lag_seconds`              | histogram | `source`                             |
| `outbox_relay_poll_duration_seconds`    | histogram | `source`                             |
| `outbox_relay_publish_duration_seconds` | histogram | `source`                             |

Label cardinality is bounded by construction — `source` is a fixed
`OUTBOX_SOURCES` entry, `event_name` is a registered contract event,
and `reason` / `outcome` are closed enums. Payloads, `event_id`, and raw
error text NEVER reach a label (CLAUDE.md §10).

## Related

- Producer SDK: `packages/nest-outbox/`
- Event registry: `packages/contracts/src/events/`
- TS-142: `Completed_tasks.md`
