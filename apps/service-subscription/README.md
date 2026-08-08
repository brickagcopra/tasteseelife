# `@taste-and-see/service-subscription`

Subscription & Billing bounded context — PDD §7.2 service inventory entry #5.

Owns: subscription plans (the catalog of products families/seniors, providers,
and Cooking Academy students can subscribe to), per-customer subscriptions,
billing cycles, dunning, and coupons.

**TS-040** ships the skeleton + plan catalog: Postgres-backed Prisma client,
`/healthz`, `/readyz`, the `plans` table, an idempotent seed
(`pnpm seed:plans`) that loads the seven Phase-1 plans (3 family tiers + 3
provider tiers + 1 academy membership), and a read-only public endpoint
`GET /api/v1/plans`.

The rest of the bounded context (per PDD §8.2 — `subscriptions`,
`subscription_history`, `coupons`, `coupon_redemptions`, `invoices`,
`invoice_line_items`, `payment_methods`) lands task-by-task alongside the
Stripe wiring:

- **TS-041** — Stripe customer + subscription create/update/cancel; webhooks.
- **TS-042** — dunning + grace + pause/resume.
- **TS-043** — coupons + redemption + abuse rate-limit.
- **TS-044** — Idempotency-Key replay middleware (Redis-backed, 24h TTL).

## Layout

```
apps/service-subscription/
├── prisma/
│   ├── schema.prisma                       # plans
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260510170000_init/            # TS-040
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
    │   └── pipes/
    │       └── zod-validation.pipe.ts       # @taste-and-see/contracts Zod boundary
    ├── health/
    │   ├── health.controller.ts             # /healthz (liveness), /readyz (DB-checked)
    │   └── health.module.ts
    ├── modules/
    │   └── plans/                           # TS-040 plan catalog
    │       ├── plans.module.ts
    │       ├── controllers/
    │       │   └── plans.controller.ts      # GET /api/v1/plans
    │       ├── services/
    │       │   └── plans.service.ts         # Decimal → minor-units DTO mapping
    │       ├── seed.ts                      # idempotent seedPlanCatalog
    │       └── seed-catalog.ts              # the seven Phase-1 plan entries
    └── scripts/
        └── seed-plans.ts                    # CLI: `pnpm seed:plans`
```

## Local development

The service expects a Postgres reachable at `DATABASE_URL` (the docker-compose
postgres on `:5432` is fine — `pnpm infra:up` from the repo root).

```bash
# 1. Bring infra up (Postgres + Redis)
pnpm infra:up

# 2. Generate the Prisma client (writes to apps/service-subscription/node_modules/.prisma/client)
pnpm -F @taste-and-see/service-subscription prisma:generate

# 3. Apply the initial migration to local Postgres
pnpm -F @taste-and-see/service-subscription prisma:migrate:deploy

# 4. Seed the Phase-1 plan catalog
pnpm -F @taste-and-see/service-subscription build
pnpm -F @taste-and-see/service-subscription seed:plans

# 5. Run the service
pnpm -F @taste-and-see/service-subscription start

# 6. Smoke-test
curl http://localhost:3012/healthz
curl http://localhost:3012/readyz
curl http://localhost:3012/api/v1/plans
```

## Container build

The canonical Dockerfile (TS-010) is parameterised:

```bash
docker build \
  -f infra/docker/nestjs.Dockerfile \
  --build-arg SERVICE_PATH=apps/service-subscription \
  --build-arg SERVICE_PACKAGE=@taste-and-see/service-subscription \
  -t taste-and-see/service-subscription:dev \
  .
```

## Environment

| Variable          | Required | Default       | Notes                                                                  |
| ----------------- | -------- | ------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`    | yes      | —             | `postgresql://user:pass@host:port/db`                                  |
| `PORT`            | no       | `3012`        | Distinct from `service-identity` (3010) and `service-household` (3011) |
| `NODE_ENV`        | no       | `development` | `development \| test \| staging \| production`                         |
| `LOG_LEVEL`       | no       | `info`        | pino levels                                                            |
| `SERVICE_VERSION` | no       | `dev`         | Set by image build to the git SHA / release tag                        |

Stripe credentials (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_API_VERSION`) land with TS-041 — the service does not consume them
yet, and adding them to the env contract before they're needed would invite
"is this required or not?" runbook ambiguity in dev.

## What's deferred

These belong to follow-up tasks:

- Stripe customer + subscription create/update/cancel + webhook signature
  verification — **TS-041**
- Dunning + grace + pause/resume — **TS-042**
- Coupons + abuse rate-limit — **TS-043**
- Idempotency-Key middleware (Redis-backed, 24h TTL) — **TS-044**
- AccessTokenGuard + `@RequirePermissions(...)` guards — added when the first
  admin-only endpoint lands (TS-127 admin subscriptions management)
- Tenant-scoping Prisma extension — **TS-141**
- Outbox pattern for `subscription.activated`, `subscription.canceled`,
  `subscription.payment_failed` — **TS-142** (event schemas already defined
  in `@taste-and-see/contracts/events`)
- OpenTelemetry tracing + Prometheus metrics — wired alongside `service-audit`
  (TS-100)

## One-time products

The Phase-1 catalog seeds **subscription plans only** (recurring monthly /
annual). PRD §5.3 names two one-time Cooking Academy purchases (Online
Certification $297–$997 and Elite In-Person Certification $2,000–$5,000+);
those aren't subscriptions, so they live in a separate product catalog that
ships with `service-academy` (TS-250). The Academy **Membership** ($49–$199/mo)
IS a subscription and is in the catalog as `academy.membership`.

## References

- PRD §5 (subscription tiers & pricing — the source of truth for plan codes,
  prices, and feature lists)
- PDD §7.2 (`subscription` service entry), §8.2 (per-table column inventory),
  §11 (payments + accounting)
- CLAUDE.md §2.3 (no cross-service joins), §3.5 (Stripe webhook signature
  verification), §4.1 (Postgres conventions — Decimal money columns), §6
  (accounting & payments — surgery), §17.6 (no float math for money)
