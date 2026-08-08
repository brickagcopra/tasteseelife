# `@taste-and-see/service-content`

Content & CMS bounded context — PDD §7.2 service inventory (content-svc), PRD
§10.10 (Blog) + §10.11 (Help Center).

Owns: marketing / CMS pages, blog & help articles, and the help-center category
tree, with append-only versioning (PDD §19). The live editorial entities
(`pages` / `articles`) carry a soft pointer to the rendered version row; bodies
live in append-only `page_versions` / `article_versions` rows (a new row per
save, never an in-place update of published copy).

**TS-280** ships the skeleton + the five core tables: Postgres-backed Prisma
client, `/healthz`, `/readyz`, and the `pages` / `page_versions` / `articles` /
`article_versions` / `help_categories` tables. Tenant-scoped per TS-141
(`enforce` mode); the five models are platform-wide editorial inventory with no
per-household tenant axis (declared `unscopedModels`, like
service-subscription's `Plan` / `Coupon` catalog or service-ads' campaign
inventory).

There is **no authenticated HTTP surface yet** — the blog admin (TS-281), page
CMS (TS-282), and help-center authoring (TS-283) land in the subsequent TS-28x
slices, at which point the JWT-verification + idempotency + Redis env clusters
arrive (the service-academy / service-ads shape). The skeleton carries no dead
config (the TS-070 / TS-221 convention).

## Layout

```
apps/service-content/
├── prisma/
│   ├── schema.prisma                       # pages / page_versions / articles / article_versions / help_categories + content_status enum
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260630120000_init/            # TS-280
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

Cross-domain facts are by id only (CLAUDE.md §2.3, §4.1). `*_versions.created_by`
is a soft FK into service-identity (the authoring staff user) — never a declared
Prisma relation into another service schema, never joined in SQL. The in-schema
relations (`page_versions.page_id`, `article_versions.article_id` → their
parents; `articles.category_id` → `help_categories.id`;
`help_categories.parent_id` self-reference) live entirely within this service's
own `content` schema.

## Local development

```bash
pnpm infra:up                                           # postgres on :5432
pnpm -F @taste-and-see/service-content prisma:generate
pnpm -F @taste-and-see/service-content prisma:migrate:deploy
pnpm -F @taste-and-see/service-content start
```

The service listens on `:3025` by default (override with `PORT`).
