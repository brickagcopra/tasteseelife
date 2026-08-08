import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { FavoriteProvidersModule } from './modules/favorite-providers/favorite-providers.module';
import { FeaturedPlacementsModule } from './modules/featured-placements/featured-placements.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { RankingConfigModule } from './modules/ranking-config/ranking-config.module';
import { RecommendationsModule } from './modules/recommendations/recommendations.module';
import { SavedSearchesModule } from './modules/saved-searches/saved-searches.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Search service composition root (TS-111).
 *
 * Modules registered here:
 *   - `AppConfigModule` / `HealthModule` — skeleton.
 *   - `NestAuthModule` — TS-052-followup-11a shared `@taste-and-see/nest-auth`
 *     wiring (`AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`).
 *     Replaces the per-service `common/guards/access-token.guard.ts`
 *     copy. Service-search is the twelfth consumer after
 *     service-provider (canonical), service-identity, service-household,
 *     service-subscription, service-booking, service-accounting,
 *     service-audit, service-activity, service-notification,
 *     service-payouts, and service-media.
 *   - `ProvidersModule` — public discovery surface + internal index
 *     upsert / delete + the `SearchBackend` binding (stub in Phase 1).
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service: a
 *     request-scoped `AsyncLocalStorage` store + the interceptor that
 *     seeds the store from `request.requestContext` (populated by
 *     `AccessTokenGuard`).
 *
 * **`PrismaModule` (TS-211)** — service-search now owns the `search`
 * Postgres schema with `search.search_ranking_config` (the per-region
 * tier-weight rows the ranking layer consumes at query time). PDD §7.2
 * names Elasticsearch as the primary store; the small Postgres
 * companion holds the ops-mutable config that has no business living
 * in ES (no transactional semantics for config; ES indices are
 * write-once-then-replace). The tenant-scope gate that was forward-
 * scaffolded with TS-020-followup-2b-platform-rollout-svc-search now
 * has a real callsite (`SearchRankingConfig` is listed as
 * `unscopedModels` since it's platform-wide ops config).
 *
 * Env wiring. `NestAuthModule.forRoot` + `TenantContextModule.forRoot`
 * both need configuration synchronously at module-definition time. We
 * call `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in `main.ts`.
 * The result is still re-validated by `AppConfigModule`'s factory
 * provider so downstream modules continue to consume `ENV_TOKEN` via
 * DI. Mirrors the service-notification / service-media / service-payouts
 * / service-audit / service-accounting / service-booking pattern.
 *
 * `TenantContextModule` (global, TS-020-followup-2b-platform-rollout).
 * Enforcement: `enforce` directly (mirroring the eleven earlier rollouts).
 * Every Prisma operation — once Prisma is wired here — will require
 * either an authenticated `RequestContext` frame (seeded by
 * `TenantContextInterceptor` from `request.requestContext`) or an
 * explicit `runWithoutTenantContext('<reason>', ...)` exempt frame. Today
 * there is no Prisma touch, so the gate has no callsite to run against;
 * the wiring is forward-compat scaffolding + a no-op interceptor that
 * still seeds the store so downstream observability (logger /
 * OpenTelemetry, when TS-111-followup-4 lands) can read the actor +
 * tenant scope without a second JWT decode.
 *
 * Pre-auth + internal exempt surface in service-search:
 *
 *   - `ProviderIndexController.upsert` (TS-020-followup-2b-platform-rollout)
 *     — `internal-search-provider-upsert` reason. The internal index
 *     endpoint `PUT /api/v1/internal/search/providers/:providerId` is
 *     pinned to a shared-secret header (`SEARCH_INDEX_API_KEY` via
 *     `SEARCH_INDEX_HEADER_NAME`) using the class-level
 *     `@UseGuards(InternalSharedSecretGuard)` so the TS-053
 *     search-indexer worker can stamp denormalised provider documents
 *     into Elasticsearch over a single cluster-internal HTTPS hop. No
 *     `AccessTokenGuard` runs and the interceptor cannot seed a scoped
 *     frame, so the handler body wraps in `runWithoutTenantContext` to
 *     satisfy the gate.
 *   - `ProviderIndexController.delete` — `internal-search-provider-delete`
 *     reason. Same shape as `upsert`. The TS-053 search-indexer worker
 *     calls `DELETE /api/v1/internal/search/providers/:providerId` when
 *     a provider is hard-deleted from the source-of-truth `provider`
 *     bounded context.
 *   - `RankingConfigController.list / .getByRegion / .upsertByRegion /
 *     .deleteByRegion` (TS-211) — `internal-search-ranking-config-{list|
 *     get|upsert|delete}` reasons. The four endpoints under
 *     `/api/v1/internal/search/ranking-config` share the same shared-
 *     secret pin (the `SEARCH_INDEX_*` env pair) so the api-gateway BFF
 *     (TS-211-followup-1) can forward super_admin-gated writes from
 *     web-admin (TS-211-followup-2) without leaking the secret to the
 *     browser. The `SearchRankingConfig` Prisma model is listed as
 *     `unscopedModels` since it's platform-wide ops config; the wrap
 *     stays in place for parity with the canonical rollout shape and
 *     because the `InternalSharedSecretGuard` does not seed a
 *     `request.requestContext`.
 *   - `RecommendationsController.recommend` (TS-213) —
 *     `internal-search-recommendations` reason. `POST
 *     /api/v1/internal/search/recommendations` shares the same
 *     `SEARCH_INDEX_*` shared-secret pin so the api-gateway BFF
 *     (`SeniorRecommendationsAggregatorController`) can forward a
 *     de-identified senior signal profile after doing actor↔senior
 *     authz. The handler resolves tier weights from the unscoped
 *     `SearchRankingConfig` row, so the same exempt-frame wrap applies;
 *     service-search never reads senior data (CLAUDE.md §2.3, §12).
 *
 * Every other surface sits behind `AccessTokenGuard`
 * (`ProviderSearchController.search` — `POST /api/v1/search/providers`;
 * `SavedSearchesController` + `FavoriteProvidersController` —
 * `/api/v1/saved-searches` and `/api/v1/favorite-providers` from
 * TS-215), so the interceptor seeds a scoped frame from the access-
 * token claims. The TS-215 controllers explicitly check row-level
 * ownership inside the service layer — every read / update / delete
 * confirms that `row.ownerUserId === actor.userId` before returning a
 * row or accepting a mutation. `HealthController.{liveness, readiness}`
 * has no Prisma touch and is exempt by construction.
 *
 * `unscopedModels: ['SearchRankingConfig']` (TS-211) — the ranking
 * config row is platform-wide ops config (region-keyed, not tenant-
 * keyed); listing it as unscoped lets the gate allow operations from
 * any authenticated frame OR the `internal-search-ranking-config-*`
 * exempt frames on the shared-secret-pinned admin surface. The TS-215
 * `SavedSearch` and `FavoriteProvider` models are NOT in the unscoped
 * list — they are per-actor and every operation must run inside a
 * scoped frame seeded by `AccessTokenGuard`.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    AppConfigModule,
    // TS-111-followup-4 — shared observability wiring: the Prometheus
    // `/metrics` scrape endpoint + the global `HttpMetricsInterceptor`
    // (meter `service-search:http`). The tracing / metrics SDK itself is
    // booted earlier by the first-line `src/observability/bootstrap.ts`
    // shim in `main.ts`; this only mounts the Nest-side surface. The
    // domain search counters / histogram / index-size gauge live in
    // `SearchMetrics` (ProvidersModule).
    ObservabilityModule.forRoot({ serviceName: 'service-search' }),
    TenantContextModule.forRoot({
      serviceName: 'service-search',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // TS-211 — `SearchRankingConfig` is platform-wide ops config
      // (region-keyed, not tenant-keyed). The model joins the
      // service-subscription `Plan` + `Coupon` and service-provider
      // `Certification` precedents — every other model in the broader
      // platform shape that exists is tenant-/household-/per-resource-
      // scoped.
      //
      // TS-207 — `FeaturedPlacement` is the same shape: platform-wide ops
      // config authored through the shared-secret-pinned internal surface
      // (and read by the ranking layer at query time), never per-tenant.
      unscopedModels: ['SearchRankingConfig', 'FeaturedPlacement'],
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
    // TS-217-prep-1 — outbox producer. service-search owns the
    // `search.outbox_events` table; `SearchAnalyticsEmitter` appends
    // `search.performed` rows here on a best-effort path off the search
    // read path. `@Global()` so `OutboxService` injects anywhere without
    // a per-module re-import.
    OutboxModule.forRoot({
      serviceName: moduleEnv.OUTBOX_PRODUCER_SERVICE,
      schemaName: 'search',
    }),
    RankingConfigModule,
    FeaturedPlacementsModule,
    ProvidersModule,
    RecommendationsModule,
    SavedSearchesModule,
    FavoriteProvidersModule,
  ],
})
export class AppModule {}
