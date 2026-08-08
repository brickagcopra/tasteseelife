# `@taste-and-see/service-academy`

Cooking Academy bounded context — PDD §7.2 service inventory entry #12.

Owns: courses, modules, lessons, cohorts, enrollments, and certifications
(PRD §9 "Functional Requirements — Cooking Academy", §5.3 pricing; PDD §15
"Cooking Academy Subsystem").

**TS-250** ships the skeleton + core schema: Postgres-backed Prisma client,
`/healthz`, `/readyz`, and the six `academy` tables — `academy_courses`,
`academy_course_modules`, `academy_lessons`, `academy_cohorts`,
`academy_enrollments`, `academy_certifications` — with their seven enums and
indexes. Tenant-scoped per TS-141 (`enforce` mode).

There is no authenticated HTTP surface yet — that arrives in the TS-25x slices:
**TS-251** course-catalog admin tooling (the first write surface — brings
`NestAuthModule` + `IdempotencyModule` + the JWT / Redis env clusters +
`academy:write` gating), **TS-252** lesson player + per-lesson progress,
**TS-253** live cohort sessions (Daily.co + attendance), **TS-254** quiz
engine, **TS-255** certification issuance (PDF + public verification URL),
**TS-256** renewal cycles.

## Schema shape

```
academy_courses          course catalog root (slug, kind, track, status)
  └─ academy_course_modules   ordered modules within a course (Cascade)
       └─ academy_lessons          ordered lessons (video|reading|quiz|assignment)
academy_cohorts          scheduled runs of a cohort-based course
academy_enrollments      per-student enrollment (course + optional cohort)
academy_certifications   per-student certification (public verification token)
```

`academy_courses` / `_course_modules` / `_lessons` / `_cohorts` are
platform-wide **catalog** content (no tenant axis — listed in `unscopedModels`,
mirroring `Plan` in service-subscription). `academy_enrollments` /
`academy_certifications` are **per-student** rows that flow through the TS-141
tenant-scope gate; row-level filtering by `student_user_id` is the service's
responsibility when the endpoints land (TS-252 / TS-255).

## Layout

```
apps/service-academy/
├── prisma/
│   ├── schema.prisma                       # 6 tables + 7 enums
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260527120000_init/            # TS-250
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

`academy_cohorts.instructor_user_id`, `academy_enrollments.student_user_id`,
and `academy_certifications.student_user_id` are soft FKs into
`identity.users.id`. The `hero_image_key` / `content_key` /
`certificate_pdf_key` columns reference `media-svc` (TS-110) S3 assets by key.
None is a Prisma relation — cross-service joins happen via the gateway BFF
(TS-140) or events (TS-142), never via SQL JOIN (CLAUDE.md §2.3, §4.1). The
course → module → lesson and course/cohort → enrollment → certification
relations ARE real FKs because every table lives in the `academy` schema.

## Local development

```bash
pnpm infra:up                                          # postgres on :5432
pnpm -F @taste-and-see/service-academy prisma:generate
pnpm -F @taste-and-see/service-academy prisma:migrate:deploy
pnpm -F @taste-and-see/service-academy start
```

The service listens on `:3022` by default (override with `PORT`).
