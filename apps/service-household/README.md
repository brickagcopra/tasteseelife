# `@taste-and-see/service-household`

Household bounded context — PDD §7.2 service inventory entry #3.

Owns: senior households, household members (primary payer, family observers, senior
users), seniors (the actual aging adults the platform serves), and the per-senior
preference profile (dietary, dementia, mobility, languages).

**TS-030** shipped the skeleton + core schema: Postgres-backed Prisma client,
`/healthz`, `/readyz`, and the three base tables (`households`, `household_members`,
`seniors`) with their enums and indexes.

**TS-031** adds the senior intake form: PUT/GET `/api/v1/seniors/:seniorId/intake`
endpoints, an `IntakePayloadCipherService` (AES-256-GCM envelope encryption with
key-versioning), an `IntakeService` that splits the payload across operational tag
columns (cleartext, queryable: `language_tags`, `dietary_tags`, `allergen_tags`,
`mobility_level`, `dementia_status`) and a sensitive encrypted payload (DOB +
freeform dietary/allergy/mobility/medical notes), and household-membership
authorisation enforced at the service layer.

Emergency contacts ship with TS-032; the memory recipes catalog with TS-033.
Additional endpoints (signup → household creation, family-member invite, senior
management) arrive alongside TS-121 (`web-family` skeleton).

## Layout

```
apps/service-household/
├── prisma/
│   ├── schema.prisma                       # households + household_members + seniors
│   └── migrations/
│       ├── migration_lock.toml
│       ├── 20260510130000_init/                  # TS-030
│       │   └── migration.sql
│       └── 20260510140000_add_senior_intake/      # TS-031
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
    │   ├── filters/
    │   │   └── http-exception.filter.ts     # RFC 7807 Problem Details + traceId
    │   ├── guards/
    │   │   └── access-token.guard.ts        # Bearer JWT verify, attaches RequestContext
    │   └── pipes/
    │       └── zod-validation.pipe.ts       # @taste-and-see/contracts Zod boundary
    ├── health/
    │   ├── health.controller.ts             # /healthz (liveness), /readyz (DB-checked)
    │   └── health.module.ts
    └── modules/
        └── intake/                           # TS-031 senior intake
            ├── intake.module.ts
            ├── controllers/
            │   └── intake.controller.ts     # PUT/GET /api/v1/seniors/:id/intake
            └── services/
                ├── intake.service.ts        # encrypt-on-write / decrypt-on-read + auth check
                └── intake-payload-cipher.service.ts  # AES-256-GCM, key-versioned
```

## Local development

The service expects a Postgres reachable at `DATABASE_URL` (the docker-compose
postgres on `:5432` is fine — `pnpm infra:up` from the repo root).

```bash
# 1. Bring infra up (Postgres + Redis)
pnpm infra:up

# 2. Generate the Prisma client (writes to apps/service-household/node_modules/.prisma/client)
pnpm -F @taste-and-see/service-household prisma:generate

# 3. Apply the initial migration to local Postgres
pnpm -F @taste-and-see/service-household prisma:migrate:deploy

# 4. Build + run
pnpm -F @taste-and-see/service-household build
pnpm -F @taste-and-see/service-household start

# 5. Smoke-test
curl http://localhost:3011/healthz
curl http://localhost:3011/readyz
```

## Container build

The canonical Dockerfile (TS-010) is parameterised:

```bash
docker build \
  -f infra/docker/nestjs.Dockerfile \
  --build-arg SERVICE_PATH=apps/service-household \
  --build-arg SERVICE_PACKAGE=@taste-and-see/service-household \
  -t taste-and-see/service-household:dev \
  .
```

## Environment

| Var                                | Required | Default                          | Notes                                                                                                                  |
| ---------------------------------- | -------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                     | yes      | —                                | `postgresql://user:pass@host:port/db`                                                                                  |
| `PORT`                             | no       | `3011`                           | Distinct from `service-identity` (3010)                                                                                |
| `NODE_ENV`                         | no       | `development`                    | `development \| test \| staging \| production`                                                                         |
| `LOG_LEVEL`                        | no       | `info`                           | pino levels                                                                                                            |
| `SERVICE_VERSION`                  | no       | `dev`                            | Set by image build to the git SHA / release tag                                                                        |
| `HOUSEHOLD_INTAKE_ENC_KEY`         | yes      | —                                | Base64-encoded 32-byte AES-256-GCM key for the encrypted senior intake payload (TS-031). Sourced from secrets manager. |
| `HOUSEHOLD_INTAKE_ENC_KEY_VERSION` | no       | `1`                              | Pointer into the keyring. Increment on rotation; backfill worker re-wraps legacy rows.                                 |
| `JWT_ACCESS_SECRET`                | yes      | —                                | HS256 verification secret shared with `service-identity` (TS-022). Phase 1 only — TS-022-followup-2 moves to RS256.    |
| `JWT_ISSUER`                       | no       | `taste-and-see/service-identity` | Pinned issuer claim — tokens from any other issuer are rejected.                                                       |
| `JWT_AUDIENCE`                     | no       | `taste-and-see/api`              | Pinned audience claim.                                                                                                 |

## What's deferred

These belong to follow-up tasks:

- Emergency contacts + household access instructions — **TS-032**
- Memory recipes catalog + senior memory profile — **TS-033**
- Endpoints: household creation, family-member invite, senior management — land
  alongside **TS-121** (`web-family` skeleton)
- Tenant-scoping Prisma extension — **TS-141** (today the intake-service does
  the row-level membership check; TS-141 pushes enforcement down a layer)
- Redis-backed `Idempotency-Key` replay cache for PUT `/intake` — **TS-031-followup-1**
  (today the header is logged for correlation; PUT is naturally idempotent on
  `(seniorId, body)` so the gap is small)
- `@RequirePermissions(...)` guards (RBAC-aware) — added when the first
  admin-only endpoint lands
- Outbox pattern for `senior.intake_updated`, `senior.added`, etc. — TS-142
- OpenTelemetry tracing + Prometheus metrics — wired alongside `service-audit`
  (TS-100)

## Cross-service references

Two columns are soft FKs into other services' schemas (CLAUDE.md §2.3, §4.1 —
"Foreign keys within a service schema; never across service schemas"):

- `households.primary_payer_user_id` → `identity.users.id`
- `household_members.user_id` → `identity.users.id`

These are plain TEXT columns with no Prisma `relation` declared. Joins across
service boundaries happen via the gateway (TS-140) or via events (TS-142),
never via direct SQL JOIN.

## References

- PRD §6.1 (household setup, role selection, intake), §6.5 (memory recipes)
- PDD §7.2 (`household` schema entry), §8.2 (per-table column inventory),
  §16.3 (privacy / PII handling)
- CLAUDE.md §2.3 (no cross-service joins), §3 (security), §4.1 (Postgres
  conventions), §17.1 (no unencrypted full DOBs / SSNs)
