# `@taste-and-see/service-analytics`

Analytics & reporting bounded context — PDD §7.2 service inventory entry #17.

Owns: read-side aggregations, dashboard marts, and scheduled reports computed
from platform domain events (PDD §23 "Analytics & Reporting" — raw events to
Cassandra, nightly aggregation to PostgreSQL marts).

**TS-217-prep-2** ships the skeleton + a placeholder schema: Postgres-backed
Prisma client, `/healthz`, `/readyz`, and the `analytics_aggregation_runs`
placeholder table (a record of each nightly aggregation worker run). Tenant-scoped
per TS-141 (`enforce` mode); the platform-standard `NestAuthModule` is wired at
skeleton time so the first authenticated read surface drops in without an env
bump.

There is **no event consumer and no aggregation worker yet** — those land in
**TS-217-prep-3**, which registers service-analytics as an outbox consumer for
`search.performed` (TS-217-prep-1) + `booking.created`, persists raw events, and
runs the nightly aggregation that powers the **TS-217** search-relevance
dashboard (top queries, zero-result rate, CTR by position, query→booking
conversion).

## Layout

```
apps/service-analytics/
├── prisma/
│   ├── schema.prisma                       # analytics_aggregation_runs + enum
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260608140000_init/            # TS-217-prep-2
│           └── migration.sql
└── src/
    ├── main.ts                             # bootstrap, env validation, structured logger
    ├── app.module.ts                       # composition root + TenantContextModule + NestAuthModule
    ├── config/
    │   ├── env.ts                          # zod-validated env, fail-fast
    │   └── config.module.ts                # global ENV provider
    ├── prisma/
    │   ├── prisma.service.ts               # PrismaClient + lifecycle + ping() + tenant-scope wrap
    │   └── prisma.module.ts                # global factory provider (wrapWithTenantScope)
    └── health/
        ├── health.controller.ts            # /healthz (liveness), /readyz (DB-checked)
        └── health.module.ts
```

## Container image

No per-service `Dockerfile` — every Nest service builds from the canonical
multi-stage template at `infra/docker/nestjs.Dockerfile` (PDD §20.1: per-service
Dockerfiles are forbidden except for genuinely bespoke needs).

## Cross-service references

Analytics is a read-side projection built from domain events. It never declares
a Prisma relation into another service schema and never joins one in SQL
(CLAUDE.md §2.3, §4.1) — every cross-domain fact arrives via the event bus.

## Local development

```bash
pnpm infra:up                                            # postgres on :5432
pnpm -F @taste-and-see/service-analytics prisma:generate
pnpm -F @taste-and-see/service-analytics prisma:migrate:deploy
pnpm -F @taste-and-see/service-analytics start
```

The service listens on `:3023` by default (override with `PORT`).
