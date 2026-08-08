import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { BullMqSchedulerModule } from '@taste-and-see/nest-bullmq-scheduler';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { SubscriptionMetricsModule } from './observability/subscription-metrics.module';
import { AdminModule } from './modules/admin/admin.module';
import { CheckoutModule } from './modules/checkout/checkout.module';
import { CouponsModule } from './modules/coupons/coupons.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { PlansModule } from './modules/plans/plans.module';
import { StripeModule } from './modules/stripe/stripe.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Subscription service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-040 skeleton.
 *   - `PlansModule` — TS-040 read-only plan catalog (`GET /api/v1/plans`).
 *   - `StripeModule` (global) — TS-041b SDK provider.
 *   - `IdempotencyModule` (global) — TS-044 Redis-backed Idempotency-Key
 *     cache covering every controller method flagged with `@Idempotent()`.
 *   - `SubscriptionsModule` — TS-041b create / patch / cancel.
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
 *
 * Future domain modules slot in under `src/modules/` per the standard
 * layout in PDD §7.1:
 *   - `dunning` — TS-042 (failed-payment retries + grace + pause/resume).
 *   - inbound webhook → DB sync handlers, once TS-142's outbox relay
 *     routes verified Stripe events from `service-webhook` into this
 *     service.
 *
 * `TenantContextModule` (global, TS-020-followup-2b-platform-rollout).
 * Wires the TS-141 tenant-scoping SDK into the service: a request-scoped
 * `AsyncLocalStorage` store, an interceptor that seeds the store from
 * `request.requestContext` (populated by `AccessTokenGuard`), and the
 * tokens the Prisma extension consumes when `PrismaModule`'s factory
 * wraps `PrismaService` with the gate (`wrapWithTenantScope`).
 *
 * Enforcement: `enforce` (TS-020-followup-2b-platform-rollout). Every
 * Prisma operation requires either an authenticated `RequestContext`
 * frame (seeded by `TenantContextInterceptor` from
 * `request.requestContext`) or an explicit
 * `runWithoutTenantContext('<reason>', ...)` exempt frame. Any unscoped
 * query is a hard `MissingRequestContextError`, not a log line — the
 * loud-failure posture CLAUDE.md §3.2 + §17.10 demand. The shape mirrors
 * the canonical wiring landed in `service-identity` under
 * TS-020-followup-2 / -2a / -2a2 / -2b; each downstream service is a
 * one-PR mechanical mirror.
 *
 * Pre-auth + internal exempt surfaces in service-subscription:
 *
 *   - `PlansController.list` (TS-020-followup-2b-platform-rollout) —
 *     `pre-auth-plans-list` reason. The public pricing catalog endpoint
 *     (`GET /api/v1/plans`) is intentionally anonymous (marketing site
 *     + family portal both render it to unauthenticated visitors), so
 *     no `AccessTokenGuard` runs and the interceptor cannot seed a
 *     scoped frame.
 *
 * Every other Prisma-touching surface sits behind `AccessTokenGuard`
 * (SubscriptionsController / CheckoutSessionsController /
 * InvoicesController / CouponsController) or `AccessTokenGuard +
 * SuperAdminRoleGuard` (AdminSubscriptionsController), so the
 * interceptor seeds a scoped frame from the access-token claims.
 * `HealthController.readiness` is exempt by construction —
 * `prisma.ping()` routes to the BASE PrismaClient, not the extended
 * client, so the gate is never consulted (see `wrapWithTenantScope`'s
 * `BASE_CLIENT_PASSTHROUGH` set).
 *
 * `unscopedModels` covers the platform-wide catalogs (`Plan`, `Coupon`)
 * — neither has a tenant axis. Plans are the same catalog every customer
 * sees on the pricing page; coupons are admin-managed promo codes
 * shared across all plans. Per-customer rows (`Subscription`,
 * `SubscriptionHistory`, `Invoice`, `InvoiceLineItem`, `PaymentMethod`,
 * `CouponRedemption`, `OutboxEvent`) flow through the gate normally.
 *
 * Env wiring. `IdempotencyModule.forRoot` + `TenantContextModule.forRoot`
 * both need configuration synchronously at module-definition time. We
 * call `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in `main.ts`.
 * The result is still re-validated by `AppConfigModule`'s factory
 * provider so downstream modules continue to consume `ENV_TOKEN` via
 * DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    AppConfigModule,
    // TS-042-followup-8 — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor`
    // (meter `service-subscription:http`). The tracing/metrics SDK init
    // happens earlier, in `src/observability/bootstrap.ts` (first import
    // in `main.ts`); by the time Nest builds this graph the global
    // MeterProvider is already wired. Domain dunning counters live in
    // the service-local `DunningMetrics` (SubscriptionsModule).
    ObservabilityModule.forRoot({ serviceName: 'service-subscription' }),
    TenantContextModule.forRoot({
      serviceName: 'service-subscription',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Platform-wide catalogs have no tenant axis. `Plan` is the same
      // pricing catalog every customer renders on the public pricing
      // page; `Coupon` is admin-managed promo codes shared across all
      // plans. Keep both out of the gate so the public `GET /api/v1/plans`
      // surface + admin-side coupon CRUD continue to work without a
      // per-callsite exempt wrap. Per-customer tables (`Subscription`,
      // `Invoice`, `PaymentMethod`, `CouponRedemption`, etc.) are
      // intentionally NOT in this list — those reads/writes still flow
      // through the gate.
      unscopedModels: ['Plan', 'Coupon'],
    }),
    PrismaModule,
    HealthModule,
    // TS-052-followup-11a — wires the shared `@taste-and-see/nest-auth`
    // package. Replaces the per-service `common/guards/access-token.guard.ts`
    // copy. Same env contract (JWT_ACCESS_SECRET / JWT_ISSUER / JWT_AUDIENCE)
    // that the local guard validated; only the import path + DI wiring
    // changed. Service-subscription is the fourth consumer after
    // service-provider (canonical), service-identity, and service-household.
    NestAuthModule.forRoot({
      jwtAccessSecret: moduleEnv.JWT_ACCESS_SECRET,
      jwtIssuer: moduleEnv.JWT_ISSUER,
      jwtAudience: moduleEnv.JWT_AUDIENCE,
      // TS-140-followup-1a — accept the api-gateway's signed actor
      // envelope in addition to a direct caller's bearer token.
      internalTrust: {
        signingSecret: moduleEnv.INTERNAL_TRUST_SIGNING_SECRET,
        maxAgeSeconds: moduleEnv.INTERNAL_TRUST_MAX_AGE_SECONDS,
      },
    }),
    StripeModule,
    IdempotencyModule.forRoot({
      environment: moduleEnv.NODE_ENV,
      serviceName: 'service-subscription',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-142-followup-9 — wires the outbox producer SDK for
    // `subscription.activated` / `.canceled` events. `schemaName` matches
    // the Postgres schema that owns the `outbox_events` table created in
    // the TS-142 migration; the relay polls `subscription.outbox_events`
    // by exact-match against this name.
    OutboxModule.forRoot({
      serviceName: 'service-subscription',
      schemaName: 'subscription',
    }),
    // TS-041b-followup-3a — the CONSUMER side. Subscribes to the relayed
    // `stripe.*` billing events service-webhook produces (TS-041a-followup-2)
    // so local rows track what Stripe actually did. Orthogonal to the
    // PRODUCER `OutboxModule` above; the two tables
    // (`subscription.outbox_events` vs `subscription.outbox_consumer_dedup`)
    // are different tables in different directions.
    //
    // TS-506 / ADR-0005 — the SDK module declares the two providers
    // `OutboxConsumerService` injects; a provider declared in
    // `OutboxConsumersModule` is not in scope at its injection site, and the
    // service dies in the injector on every boot. The factory bodies still
    // live next to the handlers they serve.
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-subscription',
      consumerName: moduleEnv.OUTBOX_CONSUMER_NAME,
      streamPrefix: moduleEnv.OUTBOX_STREAM_PREFIX,
      maxAttempts: moduleEnv.OUTBOX_CONSUMER_MAX_ATTEMPTS,
      pollBlockMs: moduleEnv.OUTBOX_CONSUMER_POLL_BLOCK_MS,
      reclaimIdleMs: moduleEnv.OUTBOX_CONSUMER_RECLAIM_IDLE_MS,
      pollIntervalMs: moduleEnv.OUTBOX_CONSUMER_POLL_INTERVAL_MS,
      imports: [AppConfigModule, PrismaModule],
      redis: outboxConsumerRedisFactory,
      dedupStore: outboxConsumerDedupStoreFactory,
    }),
    // TS-042-followup-2 — the in-service BullMQ scheduler behind the
    // dunning-exhaustion sweep. Owns the REDIS_URL decomposition, the
    // CLAUDE.md §3.7 key prefix (`{env}:service-subscription:queue`) and the
    // shutdown drain. `@Global()`, so `SubscriptionsModule` does not import
    // it. Options are validated at module-definition time — a bad REDIS_URL
    // fails the boot rather than the first tick, which would otherwise be
    // discovered an hour later in production.
    BullMqSchedulerModule.forRoot({
      serviceName: 'service-subscription',
      environment: moduleEnv.NODE_ENV,
      redisUrl: moduleEnv.REDIS_URL,
    }),
    SubscriptionMetricsModule,
    OutboxConsumersModule,
    PlansModule,
    CouponsModule,
    SubscriptionsModule,
    CheckoutModule,
    AdminModule,
  ],
})
export class AppModule {}
