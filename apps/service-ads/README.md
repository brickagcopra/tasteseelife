# `@taste-and-see/service-ads`

Ads & promotions bounded context — PDD §7.2 service inventory entry #14, PRD
§10.9 (Systemwide Ads Management System).

Owns: ad campaigns, creatives, slot placements, and targeting rules (PDD §18
"Ads & Promotions Subsystem" — inventory model, delivery, compliance &
approval). High-volume impression / click capture lands in the Cassandra
`ads.impressions` keyspace (PDD §8.3), not in this Postgres schema.

**TS-270** ships the skeleton + the four core tables: Postgres-backed Prisma
client, `/healthz`, `/readyz`, and the `ad_campaigns` / `ad_creatives` /
`ad_placements` / `ad_targeting_rules` tables. Tenant-scoped per TS-141
(`enforce` mode); the four models are platform-wide marketing-admin inventory
with no per-household tenant axis (declared `unscopedModels`, like
service-subscription's `Plan` / `Coupon` catalog).

There is **no authenticated HTTP surface yet** — the campaign admin (TS-271),
slot inventory (TS-272), targeting engine (TS-273), frequency capping (TS-274),
impression/click capture (TS-275), and sponsored disclosure (TS-278) land in
the subsequent TS-27x slices, at which point the JWT-verification +
idempotency + Redis env clusters arrive (the service-concierge / service-booking
shape). The skeleton carries no dead config (the TS-070 / TS-221 convention).

## Layout

```
apps/service-ads/
├── prisma/
│   ├── schema.prisma                       # ad_campaigns / ad_creatives / ad_placements / ad_targeting_rules + enums
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260612160000_init/            # TS-270
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

## Container image

No per-service `Dockerfile` — every Nest service builds from the canonical
multi-stage template at `infra/docker/nestjs.Dockerfile` (PDD §20.1: per-service
Dockerfiles are forbidden except for genuinely bespoke needs).

## Cross-service references

Cross-domain facts are by id only (CLAUDE.md §2.3, §4.1).
`ad_campaigns.advertiser_id` is a soft FK into service-partner /
service-provider (NULL for an internal house ad) — never a declared Prisma
relation into another service schema, never joined in SQL. The two in-schema
relations (`ad_creatives.campaign_id`, `ad_targeting_rules.campaign_id` →
`ad_campaigns.id`) live entirely within this service's own `ads` schema.

## Local development

```bash
pnpm infra:up                                       # postgres on :5432
pnpm -F @taste-and-see/service-ads prisma:generate
pnpm -F @taste-and-see/service-ads prisma:migrate:deploy
pnpm -F @taste-and-see/service-ads start
```

The service listens on `:3024` by default (override with `PORT`).
