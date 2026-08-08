import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { BookingCommissionModule } from './modules/booking-commission/booking-commission.module';
import { ChartOfAccountsModule } from './modules/chart-of-accounts/chart-of-accounts.module';
import { JournalsModule } from './modules/journals/journals.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { PeriodsModule } from './modules/periods/periods.module';
import { RefundsContraModule } from './modules/refunds-contra/refunds-contra.module';
import { RevenueRecognitionModule } from './modules/revenue-recognition/revenue-recognition.module';
import { SaasMetricsModule } from './modules/saas-metrics/saas-metrics.module';
import { StripeReconciliationModule } from './modules/stripe-reconciliation/stripe-reconciliation.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Accounting service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-080 skeleton.
 *   - `ChartOfAccountsModule` — TS-080 read-only catalog (`GET /api/v1/accounts`).
 *   - `IdempotencyModule` (global) — TS-081 Redis-backed Idempotency-Key
 *     cache covering every controller method flagged with `@Idempotent()`.
 *   - `JournalsModule` — TS-081 double-entry journal posting + reversal.
 *   - `RevenueRecognitionModule` — TS-082 deferred-revenue activation,
 *     daily recognition driver, and cancellation halt.
 *   - `PeriodsModule` — TS-085 period close + reopen workflow + the
 *     ahead-of-time monthly calendar generator. Retirement of
 *     `JournalsModule`'s lazy-create path is captured as
 *     TS-081-followup-8.
 *   - `BookingCommissionModule` — TS-083 receiver for the
 *     `booking.completed` event. Posts the four-line journal (DR Cash
 *     / CR Marketplace Revenue + DR Contra / CR Provider Payable)
 *     AND upserts the per-provider running balance.
 *   - `RefundsContraModule` — TS-084 receiver for the three PDD
 *     Appendix A flows: `coupon.redeemed` (contra-revenue),
 *     `subscription.refunded` (DR 4000.{plan} / CR Cash), and
 *     `booking.refunded` (two-leg reversal + provider clawback).
 *   - `OutboxConsumerModule` (global) — TS-142-followup-2-followup-2
 *     consumer SDK wiring; subscribes to outbox-relay-published
 *     events on Redis Streams. `OutboxConsumersModule` supplies the
 *     Redis client + `PgConsumerDedupStore` via DI tokens and
 *     registers per-event handlers from its `OnModuleInit`:
 *     `subscription.activated` → `SubscriptionRevenueRecognizerService`
 *     and `booking.completed` → `BookingCommissionRecognizerService`
 *     (TS-083-followup-3 / TS-142-followup-3).
 *   - `OutboxModule` (global) — TS-142-followup-1 PRODUCER-side outbox
 *     SDK. Orthogonal to `OutboxConsumerModule` above: this lets
 *     accounting-side producers (`journal.posted` TS-081-followup-3,
 *     recognition lifecycle TS-082-followup-3, `period.closed` /
 *     `period.reopened` TS-085-followup-3, refunds + contra-revenue
 *     lifecycle TS-084-followup-7) append domain events transactionally
 *     with their journal/balance write. The `accounting.outbox_events`
 *     table + SDK ship ahead of the per-event producer follow-ups so
 *     the migration review stays decoupled. (The CONSUMER-side
 *     `accounting.outbox_consumer_dedup` table is a different table —
 *     "events I have consumed" vs this "events I will publish".)
 *   - `TenantContextModule` (global, TS-020-followup-2b-platform-rollout) —
 *     wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
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
 * Pre-auth + internal exempt surfaces in service-accounting:
 *
 *   - `JournalsController.postSystemJournal` —
 *     `internal-journals-post` reason. `POST /api/v1/internal/journals`
 *     is the outbox-relay-side system-driven post (TS-081); pinned to
 *     `INTERNAL_POST_JOURNAL_API_KEY` rather than `AccessTokenGuard` so
 *     the `TenantContextInterceptor` cannot seed a scoped frame.
 *
 *   - `RevenueRecognitionController.recognizeActivation` —
 *     `internal-subscription-activated` reason.
 *     `POST /api/v1/internal/subscription/activated`. Same shared-secret
 *     pin as the journal post; identical wrap rationale.
 *
 *   - `RevenueRecognitionController.cancelDeferredRevenue` —
 *     `internal-subscription-canceled` reason.
 *     `POST /api/v1/internal/subscription/canceled`. Same shared-secret
 *     pin; identical wrap rationale.
 *
 *   - `BookingCommissionController.recognizeBookingCompleted` —
 *     `internal-booking-completed` reason.
 *     `POST /api/v1/internal/booking/completed`. Same shared-secret
 *     pin; identical wrap rationale.
 *
 *   - `RefundsContraController.applyCouponRedemption` —
 *     `internal-coupon-redeemed` reason.
 *     `POST /api/v1/internal/coupon/redeemed`. Same shared-secret pin;
 *     identical wrap rationale.
 *
 *   - `RefundsContraController.applySubscriptionRefund` —
 *     `internal-subscription-refunded` reason.
 *     `POST /api/v1/internal/subscription/refunded`. Same shared-secret
 *     pin; identical wrap rationale.
 *
 *   - `RefundsContraController.applyBookingRefund` —
 *     `internal-booking-refunded` reason.
 *     `POST /api/v1/internal/booking/refunded`. Same shared-secret pin;
 *     identical wrap rationale.
 *
 *   - `SaasMetricsController.computeInternal` —
 *     `internal-saas-metrics-compute` reason (TS-260).
 *     `POST /api/v1/internal/accounting/saas-metrics/compute`. Called by
 *     the `accounting-metrics` worker nightly; same shared-secret pin;
 *     identical wrap rationale. (`computeAdmin` sits behind
 *     `AccessTokenGuard` like `recognizeDaily` — no wrap.)
 *
 *   - `StripeReconciliationController.runInternal` —
 *     `internal-stripe-reconciliation-run` reason (TS-261).
 *     `POST /api/v1/internal/accounting/stripe-reconciliation/run`. Called
 *     by the `stripe-reconciliation` worker nightly; same shared-secret
 *     pin; identical wrap rationale. (`runAdmin`, `listChecks`, and
 *     `resolveCheck` sit behind `AccessTokenGuard` + `SuperAdminRoleGuard`
 *     — no wrap.)
 *
 *   - `OutboxConsumersModule` handler registration —
 *     `outbox-consumer-subscription-activated` +
 *     `outbox-consumer-booking-completed` reasons. The consumer SDK
 *     invokes each registered handler from its background poll loop
 *     (`OutboxConsumerService.pollOnce`), not from an HTTP request, so
 *     there is no `request.requestContext` for the interceptor to seed
 *     a scoped frame from. Each handler dispatch is wrapped at module
 *     init under its own per-event reason so every Prisma operation in
 *     the recognizer's transaction (and every downstream call to the
 *     `PgConsumerDedupStore` for idempotency bookkeeping) sees an
 *     explicit `exempt` frame.
 *
 * The remaining controllers — `ChartOfAccountsController`,
 * `BookingCommissionController.getProviderPayableBalance` (admin),
 * `JournalsController.postManualAdjustment` + `reverseJournal` (admin),
 * `RevenueRecognitionController.recognizeDaily` (admin),
 * `PeriodsController` (all five endpoints), and every `AdminModule`
 * controller — sit behind `AccessTokenGuard` (some additionally behind
 * `SuperAdminRoleGuard`), so the `TenantContextInterceptor` seeds a
 * scoped frame from the access-token claims before the handler body
 * runs. `HealthController.readiness` is exempt by construction —
 * `prisma.ping()` routes to the BASE PrismaClient (member of the
 * `BASE_CLIENT_PASSTHROUGH` set in `wrapWithTenantScope`), not the
 * extended client, so the gate is never consulted.
 *
 * `unscopedModels` is empty. None of the accounting models is a
 * platform-wide catalog with anonymous read access; the chart of
 * accounts is admin-read-only (`@UseGuards(AccessTokenGuard)`) and
 * the accounting periods are admin-write-only. Every Prisma model
 * (`ChartOfAccount`, `Journal`, `JournalLine`, `AccountingPeriod`,
 * `DeferredRevenueBalance`, `ProviderPayableBalance`,
 * `PeriodLifecycleEvent`, `OutboxConsumerDedup`, `SaasMetricsDaily`,
 * `SaasSubscriptionMrrDaily`, `StripeReconciliationCheck`) flows through
 * the gate normally — either a scoped frame from the access-token claims
 * (admin endpoints) or an exempt frame from a `runWithoutTenantContext`
 * wrap (internal shared-secret endpoints + outbox-consumer handler).
 * `OutboxEvent` (the TS-142-followup-1 producer table) is deliberately
 * NOT in `unscopedModels` either — the `@taste-and-see/nest-outbox` SDK
 * writes via raw SQL inside the caller's `$transaction`, so the gate's
 * model-level check never intercepts it (same posture as
 * service-identity / service-household / service-provider).
 * The `PgConsumerDedupStore`'s `$queryRaw` / `$executeRaw` calls hit
 * the gate's `DEFAULT_UNSCOPED_OPERATIONS` allow-list independently of
 * the model, so they are not gated by frame presence — but the wrap
 * around the handler registration belt-and-braces the explicit-exempt
 * frame so a future SDK switch to model-typed accessors would still
 * resolve cleanly.
 *
 * Env wiring. `IdempotencyModule.forRoot` + `TenantContextModule.forRoot`
 * + `OutboxConsumerModule.forRoot` all need configuration synchronously
 * at module-definition time (each module's dynamic shape depends on
 * runtime config). We call `loadEnv()` here once — it's pure zod
 * validation, idempotent against the same `process.env`, and matches
 * the pattern in `main.ts`. The result is still re-validated by
 * `AppConfigModule`'s factory provider so downstream modules continue
 * to consume `ENV_TOKEN` via DI. Mirrors the service-subscription /
 * service-audit pattern.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-accounting:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-accounting' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-accounting',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // No platform-wide catalog tables in this service — `ChartOfAccount`
      // is admin-read-only behind `AccessTokenGuard`, and every other
      // table is per-subscription / per-provider / per-period. Admin
      // reads seed a scoped frame from the access-token claims; internal
      // shared-secret endpoints + the outbox-consumer handler wrap in
      // `runWithoutTenantContext` explicitly. `PgConsumerDedupStore`'s
      // raw-SQL operations land in the gate's
      // `DEFAULT_UNSCOPED_OPERATIONS` allow-list independently.
      unscopedModels: [],
    }),
    PrismaModule,
    HealthModule,
    // TS-052-followup-11a — wires the shared `@taste-and-see/nest-auth`
    // package. Replaces the per-service `common/guards/access-token.guard.ts`
    // copy. Same env contract (JWT_ACCESS_SECRET / JWT_ISSUER / JWT_AUDIENCE)
    // that the local guard validated; only the import path + DI wiring
    // changed. Service-accounting is the sixth consumer after
    // service-provider (canonical), service-identity, service-household,
    // service-subscription, and service-booking.
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
    IdempotencyModule.forRoot({
      environment: moduleEnv.NODE_ENV,
      serviceName: 'service-accounting',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-142-followup-2-followup-2 — consumer SDK wiring. `consumerGroup`
    // is the service name by convention so each consumer service has
    // its own delivery position across every event stream
    // (`subscription.activated`, `booking.completed`, etc.). The Redis
    // client + `PgConsumerDedupStore` are supplied by
    // `OutboxConsumersModule`'s providers; per-event handlers are
    // registered from its `OnModuleInit`.
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-accounting',
      consumerName: moduleEnv.OUTBOX_CONSUMER_NAME,
      streamPrefix: moduleEnv.OUTBOX_STREAM_PREFIX,
      maxAttempts: moduleEnv.OUTBOX_CONSUMER_MAX_ATTEMPTS,
      pollBlockMs: moduleEnv.OUTBOX_CONSUMER_POLL_BLOCK_MS,
      reclaimIdleMs: moduleEnv.OUTBOX_CONSUMER_RECLAIM_IDLE_MS,
      pollIntervalMs: moduleEnv.OUTBOX_CONSUMER_POLL_INTERVAL_MS,
      // TS-506 / ADR-0005 — the SDK module declares the two providers
      // `OutboxConsumerService` injects. They used to be registered by
      // `OutboxConsumersModule`, where Nest could never see them: a
      // provider resolves against the module that *declares* it, and the
      // service is declared inside the SDK's own `@Global()` module. The
      // service died in the injector on every boot. The factory bodies
      // still live next to the handlers they serve.
      imports: [AppConfigModule, PrismaModule],
      redis: outboxConsumerRedisFactory,
      dedupStore: outboxConsumerDedupStoreFactory,
    }),
    // TS-142-followup-1 — PRODUCER-side outbox SDK. Wires
    // `OutboxService` so accounting-side producers (`journal.posted`
    // TS-081-followup-3, recognition lifecycle TS-082-followup-3,
    // `period.closed` / `period.reopened` TS-085-followup-3, refunds +
    // contra-revenue lifecycle TS-084-followup-7) can append domain
    // events transactionally with their state change. `schemaName`
    // matches the Postgres schema that owns the `outbox_events` table
    // created in the 20260608120000_outbox_events migration; the relay
    // polls `accounting.outbox_events` by exact-match against this name.
    // The table + SDK ship ahead of the per-event producer follow-ups so
    // the migration review stays decoupled. The SDK writes via raw SQL
    // inside the caller's `$transaction`, so the TenantContext gate's
    // model-level check never intercepts it — `OutboxEvent` deliberately
    // stays out of `unscopedModels` (mirrors service-identity /
    // service-household / service-provider's wiring). Orthogonal to the
    // `OutboxConsumerModule` above (inbound `subscription.activated` etc).
    OutboxModule.forRoot({
      serviceName: 'service-accounting',
      schemaName: 'accounting',
    }),
    ChartOfAccountsModule,
    JournalsModule,
    RevenueRecognitionModule,
    PeriodsModule,
    BookingCommissionModule,
    RefundsContraModule,
    SaasMetricsModule,
    StripeReconciliationModule,
    OutboxConsumersModule,
    AdminModule,
  ],
})
export class AppModule {}
