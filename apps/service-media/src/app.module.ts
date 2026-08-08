import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { AssetsModule } from './modules/assets/assets.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Media service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-110
 *     skeleton.
 *   - `NestAuthModule` — TS-052-followup-11a shared `@taste-and-see/nest-auth`
 *     wiring (`AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`).
 *     Replaces the per-service `common/guards/access-token.guard.ts`
 *     copy. Service-media is the eleventh consumer after
 *     service-provider (canonical), service-identity, service-household,
 *     service-subscription, service-booking, service-accounting,
 *     service-audit, service-activity, service-notification, and
 *     service-payouts.
 *   - `AssetsModule` — TS-110 signed-URL issuance, asset metadata
 *     read, and the internal scan-event ingest endpoint that the
 *     media-processor worker (TS-110-followup-1) will call.
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
 * DI. Mirrors the service-activity / service-notification /
 * service-payouts / service-audit / service-accounting pattern.
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
 * Pre-auth + internal exempt surface in service-media:
 *
 *   - `ScanEventsController.record` (TS-020-followup-2b-platform-rollout) —
 *     `internal-media-scan-event-record` reason. The internal ingest
 *     endpoint `POST /api/v1/internal/media/scan-events` is pinned to
 *     a shared-secret header (`MEDIA_SCAN_EVENTS_API_KEY` via
 *     `MEDIA_SCAN_EVENTS_HEADER_NAME`) using the class-level
 *     `@UseGuards(InternalSharedSecretGuard)` so the media-processor
 *     worker (TS-110-followup-1) can stamp each pipeline stage event
 *     over a single cluster-internal HTTPS hop without minting an
 *     access token on behalf of the system. No `AccessTokenGuard` runs
 *     and the interceptor cannot seed a scoped frame, so the handler
 *     body wraps in `runWithoutTenantContext` to satisfy the gate.
 *
 * Every other Prisma-touching surface sits behind `AccessTokenGuard`
 * (the three `AssetsController` endpoints — `POST /api/v1/media/upload-urls`,
 * `GET /api/v1/media/assets/:id`, `GET /api/v1/admin/media/assets`), so
 * the interceptor seeds a scoped frame from the access-token claims.
 * `HealthController.readiness` is exempt by construction —
 * `prisma.ping()` routes to the BASE PrismaClient, not the extended
 * client, so the gate is never consulted (see `wrapWithTenantScope`'s
 * `BASE_CLIENT_PASSTHROUGH` set).
 *
 * `unscopedModels: []` — every row in `media.media_assets` is
 * per-owner (a `(scopeKind, scopeId)` tuple resolving to a household /
 * senior / provider / course / user); every row in
 * `media.media_asset_events` belongs to a single asset. There is no
 * platform-wide catalog table to exempt. Compare with service-household
 * + service-booking + service-webhook + service-audit + service-accounting
 * + service-payouts + service-messaging + service-activity (all `[]`).
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-media:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-media' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-media',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Every row in `media.media_assets` is per-owner; every row in
      // `media.media_asset_events` belongs to a single asset. There is
      // no platform-wide catalog table to exempt. The Phase-1 row-level
      // access discipline (deferred to TS-110-followup-9) is "the owner
      // sees only their own assets; an admin with `media:read` sees
      // any asset" — that's the per-domain filter; the tenant-scope
      // gate is the cross-cutting wrapper around every Prisma operation.
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
    AssetsModule,
  ],
})
export class AppModule {}
