import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { SearchRelevanceModule } from './modules/search-relevance/search-relevance.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Analytics & reporting service composition root (TS-217-prep-2 skeleton).
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — the skeleton
 *     scaffold (zod-validated env, tenant-scoped Prisma client, `/healthz`
 *     + `/readyz`).
 *   - `TenantContextModule` (global, TS-141) — wires the tenant-scoping SDK
 *     into the service so every DI-resolved Prisma operation flows through
 *     the gate.
 *   - `NestAuthModule` (global, TS-217-prep-2) — wires the shared
 *     `AccessTokenGuard` / `PermissionGuard` from the env-sourced JWT secret
 *     / issuer / audience. No controller applies them yet (the skeleton
 *     exposes only the unauthenticated `/healthz` + `/readyz`), but the
 *     wiring lands at skeleton time as part of the tenant-scope
 *     platform-rollout shape (TS-020-followup-2b-platform-rollout) so the
 *     first authenticated read surface — the TS-217 admin dashboard read /
 *     the TS-217-prep-3 ingest endpoints — drops in without a module bump.
 *
 * Event consumers (TS-217-prep-3a). service-analytics is a read-side
 * projection (PDD §23.1) that drains two domain events off the outbox relay's
 * Redis Streams via the `@taste-and-see/nest-outbox-consumer` SDK:
 *   - `OutboxConsumerModule.forRoot` (global) — the SDK + its poll-loop
 *     scheduler. `consumerGroup: 'service-analytics'` gives this service its
 *     own delivery position across every event stream.
 *   - `OutboxConsumersModule` — supplies the Redis client + the
 *     `PgConsumerDedupStore('analytics')` and registers the handlers:
 *     `search.performed` (TS-217-prep-1) + `booking.created`, each persisting
 *     the raw event into its interim Postgres landing table
 *     (`analytics.search_events` / `analytics.booking_created_events`),
 *     idempotent on `event_id`.
 * The nightly aggregation marts that read those landing tables are the
 * `SearchRelevanceModule` (TS-217-prep-3b) — an internal shared-secret compute
 * endpoint (+ an admin back-fill trigger) that the `analytics-aggregator`
 * worker calls nightly, writing the `search_relevance_daily` /
 * `search_query_daily` / `search_sort_daily` marts and stamping one
 * `analytics_aggregation_runs` row per run.
 *
 * `TenantContextModule` enforcement: `enforce` (CLAUDE.md §3.2 + §17.10).
 * Every Prisma operation requires either an authenticated `RequestContext`
 * frame (seeded by `TenantContextInterceptor` from `request.requestContext`)
 * or an explicit `runWithoutTenantContext('<reason>', ...)` exempt frame.
 * The shape mirrors the canonical wiring landed across every other Nest
 * service; each service is a one-PR mechanical mirror.
 *
 * `unscopedModels: ['AnalyticsAggregationRun']`. Analytics is a PLATFORM-WIDE
 * read-side projection — its aggregation-run metadata (and the mart tables
 * TS-217-prep-3 introduces) aggregate ACROSS every household and carry no
 * tenant axis, so the single placeholder model is declared unscoped exactly
 * like service-subscription's `Plan` / `Coupon` platform catalog. The TS-141
 * gate treats reads/writes of an unscoped model as legitimately tenant-free.
 * Today no surface touches the model (it lands with the TS-217-prep-3 worker);
 * `HealthController` routes `prisma.ping()` to the BASE PrismaClient via
 * `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set, so the gate is never
 * consulted on the only live endpoints. When the prep-3 aggregation worker /
 * ingest surface lands, any non-`AccessTokenGuard` entrypoint (a worker tick,
 * an internal ingest webhook) MUST wrap its handler body in
 * `runWithoutTenantContext(this.tenantStore, '<reason>', ...)` with a unique,
 * grep-able reason string so the audit-log scan stays useful.
 *
 * Env wiring. `TenantContextModule.forRoot` + `NestAuthModule.forRoot` need
 * configuration synchronously at module-definition time. We call `loadEnv()`
 * here once — it's pure zod validation, idempotent against the same
 * `process.env`, and matches the pattern in `main.ts` / every other service's
 * AppModule. The result is still re-validated by `AppConfigModule`'s factory
 * provider so downstream modules continue to consume `ENV_TOKEN` via DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-analytics:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-analytics' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-analytics',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // `AnalyticsAggregationRun` (the run-log) + the TS-217-prep-3a raw-event
      // landing tables `SearchEvent` / `BookingCreatedEvent` (and every mart
      // table TS-217-prep-3b adds) are platform-wide read-side data with no
      // tenant axis — search + booking telemetry aggregates across every
      // household — declared unscoped like service-subscription's `Plan` /
      // `Coupon` catalog. `OutboxConsumerDedup` is deliberately NOT here: the
      // consumer SDK writes it via raw SQL, which the gate routes through its
      // `DEFAULT_UNSCOPED_OPERATIONS` allow-list (mirrors service-accounting).
      unscopedModels: [
        'AnalyticsAggregationRun',
        'SearchEvent',
        'BookingCreatedEvent',
        // TS-217-prep-4b — raw `search.result_clicked` landing table; same
        // platform-wide read-side projection (no tenant axis) as the other
        // raw landing tables.
        'SearchClickEvent',
        // TS-217-prep-3b — the search-relevance marts are platform-wide
        // read-side aggregations (no tenant axis) like the raw landing tables.
        'SearchRelevanceDaily',
        'SearchQueryDaily',
        'SearchSortDaily',
        // TS-217-prep-4b-followup-1 — the CTR-by-position mart is the same
        // platform-wide read-side aggregation (no tenant axis).
        'SearchClickPositionDaily',
      ],
    }),
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
    // TS-217-prep-3b — Redis-backed Idempotency-Key support for the
    // search-relevance compute endpoints (write surfaces — CLAUDE.md §17.5).
    // The compute is idempotent by construction (per-date delete-and-reinsert),
    // so the SDK defaults (24h TTL) ride on the existing `REDIS_URL`.
    IdempotencyModule.forRoot({
      environment: moduleEnv.NODE_ENV,
      serviceName: 'service-analytics',
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-217-prep-3a — consumer SDK wiring. `consumerGroup` is the service
    // name by convention so service-analytics has its own delivery position
    // across every event stream (`search.performed`, `booking.created`). The
    // Redis client + `PgConsumerDedupStore` are supplied by
    // `OutboxConsumersModule`'s providers; per-event handlers are registered
    // from its `OnModuleInit`. Mirrors service-accounting's wiring.
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-analytics',
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
    PrismaModule,
    HealthModule,
    OutboxConsumersModule,
    // TS-217-prep-3b — the nightly search-relevance aggregation (internal +
    // admin compute endpoints over the raw landing tables → the marts).
    SearchRelevanceModule,
  ],
})
export class AppModule {}
