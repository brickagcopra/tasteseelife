import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { AuditModule } from './modules/audit/audit.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Audit service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-100
 *     skeleton.
 *   - `NestAuthModule` — TS-052-followup-11a shared `@taste-and-see/nest-auth`
 *     wiring (`AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`).
 *     Replaces the per-service `common/guards/access-token.guard.ts`
 *     copy. Service-audit is the seventh consumer after service-provider
 *     (canonical), service-identity, service-household, service-subscription,
 *     service-booking, and service-accounting.
 *   - `AuditModule` — TS-100 record + list endpoints with per-resource
 *     SHA-256 hash chain. Postgres-only Phase 1; the Cassandra cold-
 *     store mirror lands as TS-100-followup-1.
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
 * Pre-auth + internal exempt surfaces in service-audit:
 *
 *   - `AuditController.recordEvent` (TS-020-followup-2b-platform-rollout) —
 *     `internal-audit-event-record` reason. The internal ingest endpoint
 *     (`POST /api/v1/internal/audit/events`) authenticates via a
 *     shared-secret header (`AUDIT_INGEST_API_KEY`), NOT
 *     `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed
 *     a scoped frame from a `request.requestContext` that does not
 *     exist. Without the wrap, every Prisma operation downstream would
 *     hard-fail with `MissingRequestContextError`. The producer service's
 *     own scoping (it stamps `actorTenantScopeType` / `actorTenantScopeId`
 *     into the event payload) is the source of truth for the audit
 *     row's tenant axis — the audit service is a pure persistence layer
 *     for whatever the producer recorded.
 *
 * The two admin endpoints (`listByResource` / `listByActor`) sit behind
 * `AccessTokenGuard` so the `TenantContextInterceptor` seeds a scoped
 * frame from the access-token claims. `HealthController.readiness` is
 * exempt by construction — `prisma.ping()` routes to the BASE
 * PrismaClient, not the extended client, so the gate is never consulted
 * (see `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set).
 *
 * `unscopedModels` is empty. `AuditEvent` is a per-resource, per-actor
 * audit log — the producer stamps its own scope on every row, and admin
 * reads happen behind `AccessTokenGuard` so the interceptor seeds a
 * scoped frame. There is no platform-wide catalog table to exempt.
 *
 * Env wiring. `NestAuthModule.forRoot` + `TenantContextModule.forRoot`
 * both need configuration synchronously at module-definition time. We
 * call `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in `main.ts`.
 * The result is still re-validated by `AppConfigModule`'s factory
 * provider so downstream modules continue to consume `ENV_TOKEN` via
 * DI. Mirrors the service-accounting / service-booking /
 * service-subscription pattern.
 *
 * Idempotency wiring (`@taste-and-see/nest-idempotency`) is
 * deliberately not registered yet — the internal ingest endpoint
 * dedups on `event_id` UNIQUE inside the service. The Idempotency-Key
 * HTTP-header surface lands when the first non-idempotent endpoint
 * arrives or when a producer asks for the HTTP-layer dedup affordance.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-audit:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-audit' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-audit',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // No platform-wide catalog tables in this service — every row in
      // `audit_events` is per-resource + per-actor. The producer stamps
      // the scope; admin reads run behind `AccessTokenGuard` so the
      // interceptor seeds a scoped frame from the access-token claims.
      // The lone exempt surface is `AuditController.recordEvent`, which
      // wraps in `runWithoutTenantContext('internal-audit-event-record',
      // ...)` because it authenticates via a shared-secret header rather
      // than the access token.
      unscopedModels: [],
    }),
    PrismaModule,
    HealthModule,
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
    // TS-271a-followup-1 / TS-272a-followup-1 / TS-277a-followup-1 — consumer
    // SDK wiring. `consumerGroup` is the service name by convention so the
    // audit service has its own delivery position on the `audit.action_recorded`
    // stream. The Redis client + `PgConsumerDedupStore` are supplied by
    // `OutboxConsumersModule`'s providers; the handler is registered from its
    // `OnModuleInit`. This is what makes the platform audit trail land:
    // producers emit to their outbox, the relay publishes, this service
    // persists append-only + hash-chained.
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-audit',
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
    AuditModule,
    OutboxConsumersModule,
  ],
})
export class AppModule {}
