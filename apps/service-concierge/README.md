# `@taste-and-see/service-concierge`

Concierge bounded context — PDD §7.2 service inventory entry #7.

Owns: concierge tickets, queues, SLA timers, escalation paths, and custom service
requests (PRD §6.6 "Concierge Service Requests", §10.6 "Concierge Operations").

**TS-221** ships the skeleton + core schema: Postgres-backed Prisma client,
`/healthz`, `/readyz`, and the `concierge_tickets` base table (id, household_id,
kind, status, sla_due_at, assigned_to_user_id, escalation_path) with its three
enums and indexes. Tenant-scoped per TS-141 (`enforce` mode).

There is no authenticated HTTP surface yet — that arrives in the TS-22x slices:
**TS-222** dedicated culinary-concierge assignment (`POST /api/v1/concierge/
assignments`, the first write surface — brings `NestAuthModule` +
`IdempotencyModule` + the JWT / Redis env clusters), **TS-223** custom-request
submission, **TS-224** ops-console queue (reads ordered by SLA proximity) +
internal notes, **TS-225** emergency concierge (PagerDuty paging).

## Layout

```
apps/service-concierge/
├── prisma/
│   ├── schema.prisma                       # concierge_tickets + enums
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260526120000_init/            # TS-221
│           └── migration.sql
└── src/
    ├── main.ts                             # bootstrap, env validation, structured logger
    ├── app.module.ts                       # composition root + TenantContextModule
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

## Cross-service references

`concierge_tickets.household_id` is a soft FK into `household.households.id`;
`concierge_tickets.assigned_to_user_id` is a soft FK into `identity.users.id`.
Neither is a Prisma relation — cross-service joins happen via the gateway BFF
(TS-140) or events (TS-142), never via SQL JOIN (CLAUDE.md §2.3, §4.1).

## Local development

```bash
pnpm infra:up                                            # postgres on :5432
pnpm -F @taste-and-see/service-concierge prisma:generate
pnpm -F @taste-and-see/service-concierge prisma:migrate:deploy
pnpm -F @taste-and-see/service-concierge start
```

The service listens on `:3021` by default (override with `PORT`).
