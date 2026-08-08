# `@taste-and-see/service-provider`

Provider bounded context — PDD §7.2 service inventory entry #4.

Owns: chef / culinary-companion / caregiver profiles, certifications, tier
(Basic / Certified / Elite — PRD §5.2), and the search-index sync that feeds
Elasticsearch-backed provider discovery (PDD §14.1).

**TS-050** ships the skeleton + core profile schema: Postgres-backed Prisma
client, `/healthz`, `/readyz`, and the `providers` table with two enums
(`provider_status`, `provider_tier`) and four indexes covering the hot read
paths.

The application surface + Checkr background-check intake (TS-051),
certifications + tier promotion workflow (TS-052), and Elasticsearch search-
index sync via the search-indexer worker (TS-053) follow.

## Layout

```
apps/service-provider/
├── prisma/
│   ├── schema.prisma                       # providers profile table
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260511130000_init/            # TS-050
│           └── migration.sql
└── src/
    ├── main.ts                              # bootstrap, env validation, structured logger
    ├── app.module.ts                        # composition root
    ├── config/
    │   ├── env.ts                           # zod-validated env, fail-fast
    │   └── config.module.ts                 # global ENV provider
    ├── prisma/
    │   ├── prisma.service.ts                # PrismaClient + lifecycle + ping()
    │   └── prisma.module.ts                 # global, exports PrismaService
    ├── common/
    │   └── filters/
    │       └── http-exception.filter.ts     # RFC 7807 Problem Details + traceId
    └── health/
        ├── health.controller.ts             # /healthz (liveness), /readyz (DB-checked)
        └── health.module.ts
```

## Local development

The service expects a Postgres reachable at `DATABASE_URL` (the docker-compose
postgres on `:5432` is fine — `pnpm infra:up` from the repo root).

```bash
# 1. Bring infra up (Postgres + Redis)
pnpm infra:up

# 2. Generate the Prisma client
pnpm -F @taste-and-see/service-provider prisma:generate

# 3. Apply the initial migration to local Postgres
pnpm -F @taste-and-see/service-provider prisma:migrate:deploy

# 4. Build + run
pnpm -F @taste-and-see/service-provider build
pnpm -F @taste-and-see/service-provider start

# 5. Smoke-test
curl http://localhost:3014/healthz
curl http://localhost:3014/readyz
```

## Container build

The canonical Dockerfile (TS-010) is parameterised:

```bash
docker build \
  -f infra/docker/nestjs.Dockerfile \
  --build-arg SERVICE_PATH=apps/service-provider \
  --build-arg SERVICE_PACKAGE=@taste-and-see/service-provider \
  -t taste-and-see/service-provider:dev \
  .
```

## Environment

| Var               | Required | Default       | Notes                                                                                |
| ----------------- | -------- | ------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL`    | yes      | —             | `postgresql://user:pass@host:port/db`                                                |
| `PORT`            | no       | `3014`        | Distinct from identity (3010), household (3011), subscription (3012), webhook (3013) |
| `NODE_ENV`        | no       | `development` | `development \| test \| staging \| production`                                       |
| `LOG_LEVEL`       | no       | `info`        | pino levels                                                                          |
| `SERVICE_VERSION` | no       | `dev`         | Set by image build to the git SHA / release tag                                      |

JWT verification, Redis idempotency cache, Checkr API key, and Elasticsearch host
arrive with their owning tasks (TS-051 / TS-053) — the env contract grows
additively so each follow-up's wiring slice stays small and reviewable.

## What's deferred

These belong to follow-up tasks:

- Provider application surface + Checkr background-check intake — **TS-051**
- Certifications + tier promotion workflow (Basic → Certified → Elite) — **TS-052**
- Elasticsearch search-index sync via the search-indexer worker — **TS-053**
- Stripe Connect Express onboarding for payouts — **TS-090** (separate service)
- `AccessTokenGuard` + `ZodValidationPipe` + `IdempotencyModule` wiring — added
  alongside the first authenticated mutation endpoint (TS-051)
- Tenant-scoping Prisma extension — **TS-141**
- Outbox pattern for `provider.created`, `provider.tier_changed`,
  `provider.suspended` events — **TS-142**
- OpenTelemetry tracing + Prometheus metrics — wired alongside `service-audit`
  (TS-100)

## Cross-service references

One column is a soft FK into another service's schema (CLAUDE.md §2.3, §4.1 —
"Foreign keys within a service schema; never across service schemas"):

- `providers.user_id` → `identity.users.id`

This is a plain TEXT column with no Prisma `relation` declared. Joins across
service boundaries happen via the gateway (TS-140) or via events (TS-142),
never via direct SQL JOIN.

## References

- PRD §5.2 (tier pricing & commission), §7 (provider app functional requirements),
  §10.7 (admin provider operations)
- PDD §7.2 (`provider-svc` service inventory entry), §8.2 (per-table column
  inventory), §14.1 (provider discovery search subsystem)
- CLAUDE.md §2.3 (no cross-service joins), §3 (security), §4.1 (Postgres
  conventions), §12 (provider tier gating)
