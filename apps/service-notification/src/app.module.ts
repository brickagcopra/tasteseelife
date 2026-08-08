import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { PreferencesModule } from './modules/preferences/preferences.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Notification service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-072
 *     skeleton.
 *   - `NestAuthModule` — TS-052-followup-11a shared `@taste-and-see/nest-auth`
 *     wiring (`AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`).
 *     Replaces the per-service `common/guards/access-token.guard.ts`
 *     copy. Service-notification is the ninth consumer after
 *     service-provider (canonical), service-identity, service-household,
 *     service-subscription, service-booking, service-accounting,
 *     service-audit, and service-activity.
 *   - `TemplatesModule` — TS-072 template CRUD + version CRUD +
 *     activate + internal `/render` endpoint.
 *   - `PreferencesModule` — TS-073 per-user preferences + quiet-hours
 *     profile management.
 *   - `DispatchModule` — TS-073 dispatch orchestrator + channel
 *     adapters (email / sms / push) + internal `/dispatch` endpoint +
 *     admin dispatch-history read.
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
 *
 * Env wiring. `NestAuthModule.forRoot` + `TenantContextModule.forRoot`
 * both need configuration synchronously at module-definition time. We
 * call `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in `main.ts`.
 * The result is still re-validated by `AppConfigModule`'s factory
 * provider so downstream modules continue to consume `ENV_TOKEN` via
 * DI. Mirrors the service-audit / service-accounting / service-booking
 * / service-messaging pattern.
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
 * Pre-auth + internal exempt surfaces in service-notification:
 *
 *   - `RenderController.render` (TS-020-followup-2b-platform-rollout) —
 *     `internal-notification-render` reason. The internal render
 *     endpoint `POST /api/v1/internal/notification/render` is
 *     shared-secret-pinned (`NOTIFICATION_RENDER_API_KEY` via
 *     `NOTIFICATION_RENDER_HEADER_NAME`) so the channel dispatchers in
 *     sibling services can fetch a fully-assembled message body without
 *     minting an access token on behalf of the system. No
 *     `AccessTokenGuard` runs and the interceptor cannot seed a scoped
 *     frame.
 *
 *   - `DispatchController.dispatch` (TS-020-followup-2b-platform-rollout) —
 *     `internal-notification-dispatch` reason. The internal dispatch
 *     endpoint `POST /api/v1/internal/notification/dispatch` is
 *     shared-secret-pinned (`NOTIFICATION_DISPATCH_API_KEY` via
 *     `NOTIFICATION_DISPATCH_HEADER_NAME`) so upstream producers
 *     (booking, subscription, household) can request a notification
 *     dispatch over a single cluster-internal HTTPS hop. Same
 *     shared-secret discipline as the render endpoint.
 *
 * Every other Prisma-touching surface sits behind `AccessTokenGuard`
 * (the six `TemplatesController` admin endpoints, the two
 * `PreferencesController` self-service endpoints, the one
 * `DispatchController.list` admin-read endpoint), so the interceptor
 * seeds a scoped frame from the access-token claims.
 * `HealthController.readiness` is exempt by construction —
 * `prisma.ping()` routes to the BASE PrismaClient, not the extended
 * client, so the gate is never consulted (see `wrapWithTenantScope`'s
 * `BASE_CLIENT_PASSTHROUGH` set).
 *
 * `unscopedModels` covers the platform-wide template registry
 * (`NotificationTemplate` + `NotificationTemplateVersion`) — neither
 * has a tenant axis in Phase 1. Templates are global per the schema
 * doc-comment ("Phase 1 templates are global"); per-tenant brand
 * overrides land with TS-400 (partner portal). The per-user / per-
 * dispatch tables (`NotificationPreference`,
 * `NotificationUserPreferenceProfile`, `NotificationDispatch`) flow
 * through the gate normally.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-notification:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-notification' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-notification',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Phase-1 templates are global per the schema doc-comment — both
      // the registry row (`NotificationTemplate`) and its monotonic
      // immutable content versions (`NotificationTemplateVersion`)
      // resolve the same content for every customer. Per-tenant brand
      // overrides land with TS-400. Per-user + per-dispatch tables
      // (`NotificationPreference`, `NotificationUserPreferenceProfile`,
      // `NotificationDispatch`) are intentionally NOT in this list —
      // those reads/writes still flow through the gate.
      unscopedModels: ['NotificationTemplate', 'NotificationTemplateVersion'],
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
    TemplatesModule,
    PreferencesModule,
    DispatchModule,
    // TS-042-followup-3a2 — the outbox consumer SDK. Registered here rather
    // than inside `OutboxConsumersModule` because `OutboxConsumerService` is
    // declared in the SDK's own `@Global()` module, so a provider declared
    // in the feature module would not be in scope at its injection site
    // (ADR-0005 / TS-506).
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-notification',
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
    OutboxConsumersModule,
  ],
})
export class AppModule {}
