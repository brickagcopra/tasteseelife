import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { AuthContextModule } from './modules/auth-context/auth-context.module';
import { GatewayRoutesModule } from './modules/gateway-routes/gateway-routes.module';
import { HouseholdScopeModule } from './modules/household-scope/household-scope.module';
import { RateLimitModule } from './modules/rate-limit/rate-limit.module';
import { ServiceRegistryModule } from './modules/service-registry/service-registry.module';
import { RedisModule } from './redis/redis.module';

/**
 * api-gateway composition root (TS-140).
 *
 * Modules registered here:
 *
 *   - `AppConfigModule` — env validation + DI binding.
 *   - `RedisModule` — singleton Redis client for the rate limiter + the
 *     /readyz probe.
 *   - `NestAuthModule` — TS-052-followup-11a shared `@taste-and-see/nest-auth`
 *     wiring (`AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`).
 *     Replaces the per-service `common/guards/access-token.guard.ts`
 *     copy. api-gateway is the final consumer in the per-service rollout
 *     after service-provider (canonical), service-identity,
 *     service-household, service-subscription, service-booking,
 *     service-accounting, service-audit, service-activity,
 *     service-notification, service-payouts, service-media, and
 *     service-search.
 *   - `AuthContextModule` — gateway-side trust-header signing.
 *   - `RateLimitModule` — sliding-window rate-limit service + guard.
 *   - `ServiceRegistryModule` — downstream service URL registry + the
 *     HTTP client that mints trust headers + applies timeouts.
 *   - `HealthModule` — /healthz + /readyz endpoints.
 *   - `GatewayRoutesModule` — Phase-1 routes: `GET /api/v1/me`
 *     (token-derived) + `GET /api/v1/plans` (proxy).
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the gateway: a
 *     request-scoped `AsyncLocalStorage` store + the interceptor that
 *     seeds the store from `request.requestContext` (populated by
 *     `AccessTokenGuard`).
 *
 * **No `PrismaModule`** — the gateway owns no Postgres schema. Pure
 * routing + auth + rate-limit + aggregation surface. The Prisma gate is
 * consequently inert today: the `TenantContextModule` is wired for
 * parity with the canonical thirteen-service rollout shape (final BFF
 * after the twelve service-* mirrors) so that if the gateway ever grows
 * a Prisma surface (none planned — the BFF contract is routing-only),
 * the gate is already in `enforce` mode + the corresponding exempt
 * wraps are already in place. Mirrors the Prisma-less posture in
 * service-search (TS-020-followup-2b-platform-rollout-svc-search).
 *
 * Env wiring. `NestAuthModule.forRoot` + `TenantContextModule.forRoot`
 * both need configuration synchronously at module-definition time. We
 * call `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in `main.ts`.
 * The result is still re-validated by `AppConfigModule`'s factory
 * provider so downstream modules continue to consume `ENV_TOKEN` via
 * DI. Mirrors the service-search / service-media / service-notification
 * / service-payouts / service-audit / service-accounting /
 * service-booking pattern.
 *
 * `TenantContextModule` (global, TS-020-followup-2b-platform-rollout).
 * Enforcement: `enforce` directly (mirroring the thirteen earlier
 * rollouts). Every Prisma operation — once Prisma is wired here, if
 * ever — will require either an authenticated `RequestContext` frame
 * (seeded by `TenantContextInterceptor` from `request.requestContext`)
 * or an explicit `runWithoutTenantContext('<reason>', ...)` exempt
 * frame. Today there is no Prisma touch, so the gate has no callsite
 * to run against; the wiring is forward-compat scaffolding + a no-op
 * interceptor that still seeds the store so downstream observability
 * (logger / OpenTelemetry, when TS-140-followup-4 lands) can read the
 * actor + tenant scope without a second JWT decode.
 *
 * Pre-auth + internal exempt surface in api-gateway:
 *
 *   - `AuthProxyController.signup`    — `gateway-pre-auth-signup` reason.
 *   - `AuthProxyController.login`     — `gateway-pre-auth-login` reason.
 *   - `AuthProxyController.refresh`   — `gateway-pre-auth-refresh` reason.
 *   - `AuthProxyController.mfaVerify` — `gateway-pre-auth-mfa-verify`
 *     reason. All four sit behind `@UseGuards(RateLimitGuard)` only —
 *     no `AccessTokenGuard` runs (these are the auth-bootstrap surfaces
 *     by definition) and the interceptor cannot seed a scoped frame,
 *     so the handler bodies wrap in `runWithoutTenantContext` to
 *     satisfy the gate (defence-in-depth — there is no Prisma in this
 *     service today, but a future maintainer adding a Prisma read-side
 *     cache or a write-through idempotency table would otherwise hit
 *     a hard `MissingRequestContextError`).
 *
 * Every other surface sits behind `AccessTokenGuard` (`MeController`,
 * `PlansProxyController`, `BookingsProxyController`,
 * `CheckoutSessionsProxyController`, `InvoicesProxyController`,
 * `SearchProvidersProxyController`, `ProvidersProxyController`, and
 * the seven admin proxies), so the interceptor seeds a scoped frame
 * from the access-token claims. `HealthController.{liveness, readiness}`
 * has no Prisma touch and is exempt by construction.
 *
 * `unscopedModels: []` — api-gateway owns no Prisma models today; the
 * empty array is the simplest case alongside service-search +
 * service-household + service-booking + service-webhook + service-audit
 * + service-accounting + service-payouts + service-messaging +
 * service-activity + service-media (all `[]`).
 *
 * Deferred (TS-140 follow-ups):
 *   - Downstream-side trust-header verification — TS-140-followup-1.
 *   - Testcontainers integration test — TS-140-followup-2.
 *   - Active-rollup downstream readiness probes — TS-140-followup-3.
 *   - OpenTelemetry tracing + Prometheus metrics — TS-140-followup-4.
 *   - Idempotency cache (`@taste-and-see/nest-idempotency`) on write
 *     proxies — TS-140-followup-5.
 *   - OpenAPI schema generator — TS-140-followup-6.
 *   - GraphQL gateway (PDD §29.4 deferred Phase 2 evaluation).
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `api-gateway:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'api-gateway' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'api-gateway',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // api-gateway owns no Prisma schema — pure routing + auth +
      // rate-limit + aggregation surface. The empty array reflects the
      // lack of any catalog table here; the wiring exists for parity
      // with the canonical thirteen-service rollout shape so if the
      // gateway ever grows Prisma surface (unlikely — the BFF contract
      // is routing-only), the gate is already in place.
      unscopedModels: [],
    }),
    RedisModule,
    NestAuthModule.forRoot({
      jwtAccessSecret: moduleEnv.JWT_ACCESS_SECRET,
      jwtIssuer: moduleEnv.JWT_ISSUER,
      jwtAudience: moduleEnv.JWT_AUDIENCE,
    }),
    AuthContextModule,
    ServiceRegistryModule,
    // TS-505d2-followup-5 — must sit AFTER ServiceRegistryModule (it needs
    // DownstreamHttpClient) and BEFORE GatewayRoutesModule: Nest runs global
    // interceptors in module-registration order, and the household tenant
    // scope has to be settled before any route reads the request context.
    HouseholdScopeModule,
    RateLimitModule,
    HealthModule,
    GatewayRoutesModule,
  ],
})
export class AppModule {}
