import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { ActivityModule } from './modules/activity/activity.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Activity service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-101
 *     skeleton.
 *   - `NestAuthModule` — TS-052-followup-11a shared `@taste-and-see/nest-auth`
 *     wiring (`AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`).
 *     Replaces the per-service `common/guards/access-token.guard.ts`
 *     copy. Service-activity is the eighth consumer after service-provider
 *     (canonical), service-identity, service-household, service-subscription,
 *     service-booking, service-accounting, and service-audit.
 *   - `ActivityModule` — TS-101 record + self-view + admin-search
 *     endpoints. Postgres-only Phase 1; the Cassandra cold-store mirror
 *     lands as TS-101-followup-1.
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
 * / service-subscription / service-notification pattern.
 *
 * Idempotency wiring (`@taste-and-see/nest-idempotency`) is
 * deliberately not registered yet — the internal ingest endpoint
 * dedups on `event_id` UNIQUE inside the service. The Idempotency-Key
 * HTTP-header surface lands when the first non-idempotent endpoint
 * arrives or when a producer asks for the HTTP-layer dedup affordance.
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
 * Pre-auth + internal exempt surface in service-activity:
 *
 *   - `ActivityController.recordEvent` (TS-020-followup-2b-platform-rollout) —
 *     `internal-activity-event-record` reason. The internal ingest
 *     endpoint `POST /api/v1/internal/activity/events` is shared-secret-
 *     pinned (`ACTIVITY_INGEST_API_KEY` via `ACTIVITY_INGEST_HEADER_NAME`)
 *     so every producer service (identity, subscription, booking,
 *     household, provider, ...) can stamp an event over a single
 *     cluster-internal HTTPS hop without minting an access token on
 *     behalf of the system. No `AccessTokenGuard` runs and the
 *     interceptor cannot seed a scoped frame.
 *
 * Every other Prisma-touching surface sits behind `AccessTokenGuard`
 * (the self-view `GET /api/v1/users/me/activity` and the admin search
 * `GET /api/v1/admin/users/:userId/activity`), so the interceptor seeds
 * a scoped frame from the access-token claims.
 * `HealthController.readiness` is exempt by construction —
 * `prisma.ping()` routes to the BASE PrismaClient, not the extended
 * client, so the gate is never consulted (see `wrapWithTenantScope`'s
 * `BASE_CLIENT_PASSTHROUGH` set).
 *
 * `unscopedModels: []` — every row in `activity.activity_events` is
 * per-user; there is no platform-wide catalog table to exempt. The
 * service-layer self-view filters by `userId` server-side, and the
 * admin search adds permission gating (`activity:read`, TS-101-followup-7)
 * once `PermissionGuard` lifts (TS-052-followup-11). Compare with
 * service-household + service-booking + service-webhook + service-audit
 * + service-accounting + service-payouts + service-messaging (all `[]`).
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-activity:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-activity' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-activity',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Every row in `activity.activity_events` is per-user; there is
      // no platform-wide catalog table to exempt. The Phase-1 row-level
      // access discipline is "the actor sees only their own rows" — the
      // self-view filters by `userId` server-side; the admin search
      // adds permission gating (`activity:read`, TS-101-followup-7).
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
    ActivityModule,
  ],
})
export class AppModule {}
