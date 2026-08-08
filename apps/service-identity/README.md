# `@taste-and-see/service-identity`

Identity & Auth bounded context — PDD §7.2 service inventory entry #2.

Owns: user accounts, sessions, JWT issuance, MFA enrollment, KYC light, role
assignments. **TS-020 ships only the skeleton:** Postgres-backed Prisma client,
`/healthz`, `/readyz`. Auth flows arrive in TS-021 → TS-026.

## Layout

```
apps/service-identity/
├── prisma/
│   ├── schema.prisma                 # User table only — see schema for scope notes
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260509000000_init/
│           └── migration.sql
└── src/
    ├── main.ts                        # bootstrap, env validation, structured logger
    ├── app.module.ts                  # composition root
    ├── config/
    │   ├── env.ts                     # zod-validated env, fail-fast
    │   └── config.module.ts           # global ENV provider
    ├── prisma/
    │   ├── prisma.service.ts          # PrismaClient + lifecycle + ping()
    │   └── prisma.module.ts           # global, exports PrismaService
    └── health/
        ├── health.controller.ts       # /healthz (liveness), /readyz (DB-checked)
        └── health.module.ts
```

## Local development

The service expects a Postgres reachable at `DATABASE_URL` (the docker-compose
postgres on `:5432` is fine — `pnpm infra:up` from the repo root).

```bash
# 1. Bring infra up (Postgres + Redis)
pnpm infra:up

# 2. Generate the Prisma client (writes to apps/service-identity/node_modules/.prisma/client)
pnpm -F @taste-and-see/service-identity prisma:generate

# 3. Apply the initial migration to local Postgres
pnpm -F @taste-and-see/service-identity prisma:migrate:deploy

# 4. Build + run
pnpm -F @taste-and-see/service-identity build
pnpm -F @taste-and-see/service-identity start

# 5. Smoke-test
curl http://localhost:3010/healthz
curl http://localhost:3010/readyz
```

## Container build

The canonical Dockerfile (TS-010) is parameterised:

```bash
docker build \
  -f infra/docker/nestjs.Dockerfile \
  --build-arg SERVICE_PATH=apps/service-identity \
  --build-arg SERVICE_PACKAGE=@taste-and-see/service-identity \
  -t taste-and-see/service-identity:dev \
  .
```

## Environment

| Var               | Required | Default       | Notes                                              |
| ----------------- | -------- | ------------- | -------------------------------------------------- |
| `DATABASE_URL`    | yes      | —             | `postgresql://user:pass@host:port/db`              |
| `PORT`            | no       | `3010`        | Override per service when running multiple locally |
| `NODE_ENV`        | no       | `development` | `development \| test \| staging \| production`     |
| `LOG_LEVEL`       | no       | `info`        | pino levels                                        |
| `SERVICE_VERSION` | no       | `dev`         | Set by image build to the git SHA / release tag    |

JWT secrets are not declared yet — they land with TS-022 (login + refresh
with reuse detection) and become required at that point.

## What's deferred

These belong to follow-up tasks, not the skeleton:

- Signup / login / refresh-with-reuse-detection — TS-021, TS-022
- MFA TOTP — TS-023
- RBAC seed (system roles + permissions matrix) — TS-024
- Failed-login lockout (per-user backoff, IP circuit breaker) — TS-025
- Stripe Identity light KYC — TS-026
- Tenant-scoping Prisma extension — TS-141
- `@RequirePermissions(...)` guards on mutating endpoints — lands with the
  first mutation (TS-021)
- Idempotency middleware — TS-044 (subscription-svc) defines the shared
  pattern; identity-svc adopts it for `POST /signup` once landed
- Outbox pattern for `user.created` etc. — TS-142
- OpenTelemetry tracing + Prometheus metrics — wired alongside `service-audit`
  (TS-100)

## References

- PRD §6.1 (signup), §10.2 (admin user mgmt), §10.12 (RBAC)
- PDD §7.1 (standard service layout), §7.2 (`identity` schema), §10
  (auth & authz), §16.3 (privacy/PII)
- CLAUDE.md §3.1 (auth & sessions), §3.2 (authz), §4.1 (Postgres conventions),
  §17 (absolute prohibitions)
