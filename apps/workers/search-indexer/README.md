# worker-search-indexer

Search-indexer worker for the Taste & See platform (TS-053).

A long-running process that subscribes to provider domain events on
Redis Streams (`provider.tier_changed`, `provider.certification_granted`,
`provider.certification_revoked`), fetches the materialised
`ProviderDiscoveryDocument` from service-provider's internal
discovery-snapshot endpoint, and PUTs (or DELETEs) it on
service-search's internal upsert endpoint.

Implements the projection half of **PDD §8.5** / **§14.1** —
the family-portal's provider-discovery index is kept fresh via this
worker as providers' tier and certification state changes.

## Architecture

```
service-provider                              service-search
        │                                            ▲
        │ tx { tier/cert change + outbox.append }    │ PUT /internal/search/providers/:id
        ▼                                            │   body: { document }
┌───────────────────────┐                            │
│ provider              │                            │
│ .outbox_events        │   ┌────────────────────────┴──────────┐
└───────────────────────┘   │       worker-search-indexer       │
        │                   │                                   │
        │                   │  1. XREADGROUP fresh entries from │
        ▼                   │     events:provider.tier_changed  │
┌───────────────────────┐   │     + .certification_granted      │
│ worker-outbox-relay   │──▶│     + .certification_revoked      │
│ XADD events:...       │   │  2. GET /internal/providers/:id/  │
└───────────────────────┘   │       discovery-snapshot          │
        │                   │  3. found → PUT to service-search │
        ▼                   │     not_found → DELETE            │
   Redis Streams            │  4. XACK                          │
                            └───────────────────────────────────┘
```

## Configuration

| Variable                                  | Default                                 | Notes                                                         |
| ----------------------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| `REDIS_URL`                               | _required_                              | Same Redis Streams bus the relay writes to.                   |
| `PROVIDER_SERVICE_BASE_URL`               | _required_                              | Base URL of service-provider. No trailing slash.              |
| `PROVIDER_DISCOVERY_INTERNAL_API_KEY`     | _required_                              | Shared secret matching service-provider's value (≥ 32 chars). |
| `PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME` | `x-provider-discovery-internal-api-key` | Header carrying the secret.                                   |
| `PROVIDER_REQUEST_TIMEOUT_MS`             | `5000`                                  | Per-call timeout, [500, 30000].                               |
| `SEARCH_SERVICE_BASE_URL`                 | _required_                              | Base URL of service-search.                                   |
| `SEARCH_INDEX_API_KEY`                    | _required_                              | Shared secret matching service-search's value (≥ 32 chars).   |
| `SEARCH_INDEX_HEADER_NAME`                | `x-internal-api-key`                    | Header carrying the secret.                                   |
| `SEARCH_REQUEST_TIMEOUT_MS`               | `5000`                                  | Per-call timeout.                                             |
| `OUTBOX_CONSUMER_GROUP`                   | `worker-search-indexer`                 | Redis consumer-group name.                                    |
| `OUTBOX_CONSUMER_NAME`                    | `default`                               | Per-pod consumer name (wire to `$HOSTNAME` in prod).          |
| `OUTBOX_STREAM_PREFIX`                    | `events`                                | Must match relay's `STREAM_NAME_PREFIX`.                      |
| `OUTBOX_MAX_ATTEMPTS`                     | `10`                                    | Dead-letter cap.                                              |
| `OUTBOX_POLL_BLOCK_MS`                    | `5000`                                  | `XREADGROUP BLOCK` value.                                     |
| `OUTBOX_RECLAIM_IDLE_MS`                  | `60000`                                 | `XAUTOCLAIM` idle threshold.                                  |
| `OUTBOX_POLL_INTERVAL_MS`                 | `1000`                                  | Gap between empty-poll re-arms.                               |
| `PORT`                                    | `3051`                                  | Health-probe HTTP port.                                       |
| `LOG_LEVEL`                               | `info`                                  |                                                               |
| `NODE_ENV`                                | `development`                           |                                                               |
| `SERVICE_VERSION`                         | `dev`                                   |                                                               |

## Idempotency

Three layers, in order of effectiveness:

1. **service-search's upsert** dedupes on `(providerId, sourceUpdatedAt)`.
   The doc the worker PUTs carries the provider row's `updatedAt`;
   a redelivery that produces the same `sourceUpdatedAt` returns
   `outcome: 'unchanged'` without overwriting.

2. **The Redis Streams PEL** persists redelivery state across worker
   restarts. A pod crash leaves entries in `pending`; on restart
   `XAUTOCLAIM` reclaims them past `OUTBOX_RECLAIM_IDLE_MS`.

3. **MemoryConsumerDedupStore** — in-process dedup inside one pod's
   lifetime. Phase-1 choice because the worker has no Postgres of
   its own; a future follow-up can swap in `PgConsumerDedupStore` if
   cross-restart dedup becomes operationally meaningful.

## Failure model

- **service-provider down**: `ProviderSnapshotClientError` thrown →
  consumer SDK records failure → retries on next delivery cycle.
- **service-search down**: same — `SearchIndexClientError` thrown.
- **Malformed providerId on the event** (would only happen on a bug
  upstream): `kind: 'invalid_provider_id'` outcome → XACK without
  retry (the event won't fix itself).
- **Stale event**: harmless. The orchestrator always fetches the
  current snapshot; whichever event triggered the cycle, the doc
  reflects "now".
- **Maximum attempts exceeded**: dead-lettered in the SDK's dedup
  store + XACKed. Ops triage out-of-band (TS-142-followup-5).

## Health probes

- `GET /healthz` — liveness; always 200.
- `GET /readyz` — readiness; pings Redis; 503 if unreachable.

## Related

- Consumer SDK: `packages/nest-outbox-consumer/`
- Event registry: `packages/contracts/src/events/`
- Service-side endpoints: `apps/service-provider/src/modules/discovery/`
  and `apps/service-search/src/modules/providers/`
- TS-053 / TS-052-followup-1 / TS-142-followup-1: `Completed_tasks.md`
