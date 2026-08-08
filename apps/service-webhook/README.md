# `@taste-and-see/service-webhook`

Inbound third-party webhook receiver — PDD §7.2 service inventory entry #22.

Owns: signature verification + idempotent persistence + forward-only dispatch
of inbound webhooks from third parties (Stripe billing now; Checkr background
checks and Twilio delivery receipts arrive under sibling tables).

**TS-041a** ships the skeleton + the signature-verified Stripe ingress:

- Postgres-backed Prisma client; `webhook` schema with the
  `stripe_processed_events` table (primary key on Stripe's `event.id`).
- `/healthz` (liveness) + `/readyz` (Postgres-pinged).
- `POST /api/v1/webhooks/stripe` — HMAC-verified via the Stripe SDK; the
  raw request body is preserved by a path-scoped `express.raw` parser so
  signature math sees byte-exact input.
- Idempotency: a duplicate `event.id` (Stripe retry; manual Dashboard
  resend; our own replay) hits the primary-key constraint and acks 200
  without re-running any downstream handler.

**No business handlers run yet.** Events are persisted and acked but not
dispatched. Downstream consumers — service-subscription on
`customer.subscription.*`, service-accounting on `invoice.paid` /
`payment_intent.succeeded`, etc. — wire in via the outbox relay (TS-142)
which reads `dispatched_at IS NULL` rows and forwards them to the event bus.

## Layout

```
apps/service-webhook/
├── prisma/
│   ├── schema.prisma                          # stripe_processed_events
│   └── migrations/
│       ├── migration_lock.toml
│       └── 20260510180000_init/               # TS-041a
│           └── migration.sql
└── src/
    ├── main.ts                                # bootstrap + path-scoped raw body
    ├── app.module.ts                          # composition root
    ├── config/
    │   ├── env.ts                             # zod-validated env (incl. STRIPE_WEBHOOK_SECRET)
    │   └── config.module.ts
    ├── prisma/
    │   ├── prisma.service.ts
    │   └── prisma.module.ts
    ├── common/
    │   ├── filters/http-exception.filter.ts   # RFC 7807 Problem Details
    │   └── pipes/zod-validation.pipe.ts
    ├── health/
    │   ├── health.controller.ts               # /healthz, /readyz
    │   └── health.module.ts
    └── modules/
        └── stripe/
            ├── stripe.module.ts               # SDK provider + verifier + ingress
            ├── stripe.constants.ts            # STRIPE_WEBHOOK_PATH, STRIPE_SDK_TOKEN
            ├── controllers/
            │   └── stripe-webhook.controller.ts
            └── services/
                ├── stripe-webhook-verifier.service.ts   # constructEvent wrapper
                └── stripe-ingress.service.ts            # idempotent persist
```

## Local development

The service expects a Postgres reachable at `DATABASE_URL` (the
docker-compose postgres on `:5432` is fine — `pnpm infra:up` from the repo
root) plus a Stripe webhook signing secret.

```bash
# 1. Bring infra up (Postgres + Redis)
pnpm infra:up

# 2. Generate the Prisma client
pnpm -F @taste-and-see/service-webhook prisma:generate

# 3. Apply the initial migration
pnpm -F @taste-and-see/service-webhook prisma:migrate:deploy

# 4. Run the service (uses stripe-cli for a local signing secret)
stripe listen --forward-to http://localhost:3013/api/v1/webhooks/stripe
# Copy the `whsec_...` it prints into STRIPE_WEBHOOK_SECRET:
export STRIPE_WEBHOOK_SECRET=whsec_...
export DATABASE_URL=postgresql://tastesee:tastesee_dev_only@localhost:5432/tastesee
pnpm -F @taste-and-see/service-webhook build
pnpm -F @taste-and-see/service-webhook start

# 5. Smoke-test — trigger a sample event
stripe trigger customer.subscription.created
# Verify it persisted:
psql -U tastesee -d tastesee -c \
  'SELECT event_id, event_type, livemode, dispatched_at FROM webhook.stripe_processed_events;'
```

## Container build

The canonical Dockerfile (TS-010) is parameterised:

```bash
docker build \
  -f infra/docker/nestjs.Dockerfile \
  --build-arg SERVICE_PATH=apps/service-webhook \
  --build-arg SERVICE_PACKAGE=@taste-and-see/service-webhook \
  -t taste-and-see/service-webhook:dev \
  .
```

## Environment

| Variable                           | Required | Default       | Notes                                                                                  |
| ---------------------------------- | -------- | ------------- | -------------------------------------------------------------------------------------- | ---- | ------- | ----------- |
| `DATABASE_URL`                     | yes      | —             | `postgresql://user:pass@host:port/db`                                                  |
| `STRIPE_WEBHOOK_SECRET`            | **yes**  | —             | `whsec_...` from the Stripe Dashboard or `stripe listen --print-secret`. Min 20 chars. |
| `STRIPE_API_VERSION`               | no       | _SDK default_ | Pinned in the Stripe Dashboard endpoint config; record-keeping only here.              |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | no       | `300`         | Replay-rejection window; clamped to `[60, 900]`.                                       |
| `PORT`                             | no       | `3013`        | Distinct from identity (3010), household (3011), subscription (3012).                  |
| `NODE_ENV`                         | no       | `development` | `development                                                                           | test | staging | production` |
| `LOG_LEVEL`                        | no       | `info`        | pino levels                                                                            |
| `SERVICE_VERSION`                  | no       | `dev`         | Set by image build to the git SHA / release tag                                        |

The `STRIPE_WEBHOOK_SECRET` is the only authentication boundary on the
inbound webhook path — there is no other auth mechanism. The schema makes
it mandatory; bootstrap fails fast if it is missing.

## What's deferred

These belong to follow-up tasks:

- Subscription-svc Stripe customer + subscription create/update/cancel —
  **TS-041b** (the sibling slice of TS-041)
- Outbox relay (events → event bus → consumer services) — **TS-142**
- Business handlers (`customer.subscription.created` →
  service-subscription, `payment_intent.succeeded` → accounting, etc.) —
  ship alongside their owning service post-TS-142
- OpenTelemetry tracing + Prometheus metrics — wired alongside
  `service-audit` (TS-100)
- Checkr inbound webhook — **TS-051**
- Twilio delivery receipts — TS-073 follow-up
- Testcontainers integration test with a stripe-cli signed sample —
  alongside **TS-009e**
- Janitor: prune `stripe_processed_events` older than the configured
  retention window (default 13mo — matches Stripe's own event retention)

## References

- PDD §7.2 (`webhook-svc` service entry), §11.1 (Stripe Integration), §11.2
  (double-entry accounting webhook-driven entries)
- CLAUDE.md §3.5 (Stripe webhook signature verification — mandatory),
  §17.8 (banned: sending unsigned webhook responses), §6 (idempotent on
  `event.id`)
- Stripe Webhook docs: <https://docs.stripe.com/webhooks/signatures>
