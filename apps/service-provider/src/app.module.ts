import { Module } from '@nestjs/common';
import { AuditModule } from '@taste-and-see/nest-audit';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { ApplicationsModule } from './modules/applications/applications.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { CalendarSyncModule } from './modules/calendar-sync/calendar-sync.module';
import { CertificationsModule } from './modules/certifications/certifications.module';
import { ProviderBillingContactsModule } from './modules/billing-contacts/provider-billing-contacts.module';
import { ProviderDiscoveryModule } from './modules/discovery/provider-discovery.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { DossierModule } from './modules/dossier/dossier.module';
import { MetricsModule } from './modules/metrics/metrics.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { ProfileModule } from './modules/profile/profile.module';
import { ServiceAreasModule } from './modules/service-areas/service-areas.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Provider service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-050
 *     skeleton.
 *   - `ObservabilityModule` — TS-050-followup-1. OpenTelemetry tracing
 *     + the Prometheus `/metrics` scrape endpoint + the global
 *     HTTP-metrics interceptor. Mirrors service-identity's
 *     observability wiring (TS-020-followup-1).
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
 *   - `IdempotencyModule` (global) — TS-051 Redis-backed
 *     Idempotency-Key replay cache covering every controller method
 *     flagged with `@Idempotent()`. Pulls in @taste-and-see/nest-
 *     idempotency.
 *   - `OutboxModule` (global) — TS-142-followup-1 producer SDK wired
 *     for `provider.certification_granted` / `.certification_revoked`
 *     / `.tier_changed` events. `schemaName` matches the Postgres
 *     schema that owns the `outbox_events` table created in the
 *     20260516120000_outbox_events migration; the relay polls
 *     `provider.outbox_events` by exact-match against this name
 *     when its `OUTBOX_SOURCES` env additively includes
 *     `provider.outbox_events`.
 *   - `ApplicationsModule` — TS-051 provider-application surface +
 *     Checkr background-check intake.
 *   - `CertificationsModule` — TS-052 certifications catalog +
 *     per-provider issuance log + tier-promotion machinery.
 *   - `ProviderBillingContactsModule` — TS-042-followup-3a1a internal
 *     `POST /api/v1/internal/providers/billing-contacts`, resolving a
 *     provider id to its owning account so a provider whose card fails
 *     reaches the dunning ladder. Own shared secret; see the env
 *     doc-block for why it is not the discovery one.
 *   - `ProviderDiscoveryModule` — TS-053 internal read-only
 *     discovery-snapshot endpoint the `apps/workers/search-indexer`
 *     worker pulls from. Pinned to a shared-secret header
 *     (`PROVIDER_DISCOVERY_INTERNAL_API_KEY`).
 *   - `ProfileModule` — TS-200 self-service profile-edit surface
 *     (`PUT /api/v1/providers/:providerId/profile`) + the
 *     `provider.profile_updated` outbox emission.
 *   - `AvailabilityModule` — TS-203 self-service availability editor
 *     (`PUT /api/v1/providers/:providerId/availability`) + the
 *     `provider.availability_updated` outbox emission.
 *   - `ServiceAreasModule` — TS-202 self-service coverage-polygon
 *     editor (`PUT /api/v1/providers/:providerId/service-areas`) + the
 *     `provider.service_areas_updated` outbox emission. Stores GeoJSON
 *     in a `jsonb` column; computes centroid + bounding box in app
 *     code (no PostGIS).
 *   - `DirectoryModule` — TS-305c-followup-1 admin provider directory
 *     (`GET /api/v1/admin/providers`), gated `provider:read`. The list
 *     surface an operator uses to FIND a provider; the 360 was
 *     previously reachable only from an incident that already named
 *     one.
 *   - `DossierModule` — TS-305a admin provider dossier
 *     (`GET /api/v1/admin/providers/:providerId/dossier`), gated on the
 *     new `provider:read` permission. Read-only composition over
 *     `ProfileModule` + `CertificationsModule` plus a verdict-only
 *     projection of the latest background check.
 *   - `PricingModule` — TS-204 self-service pricing-band editor
 *     (`PUT /api/v1/providers/:providerId/pricing`) + the
 *     `provider.pricing_updated` outbox emission. Enforces the
 *     `providers.hourly_rate` sits inside the platform band for the
 *     provider's tier (the band lives in the contract layer's
 *     `PROVIDER_PRICING_BANDS`).
 *
 * Future domain modules slot in under `src/modules/` per the
 * standard layout in PDD §7.1:
 *   - `documents` — TS-052-followup (food handler cert + insurance
 *     proof upload via media-svc).
 *   - `availability` — TS-053 (service areas + recurring weekday/
 *     time-of-day windows + the search-indexer integration).
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). Wires the TS-141
 * tenant-scoping SDK into the service: a request-scoped
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
 * Pre-auth + internal exempt surfaces in service-provider:
 *
 *   - `CertificationsController.listCatalog`
 *     (TS-020-followup-2b-platform-rollout) — `pre-auth-certifications-list`
 *     reason. `GET /api/v1/certifications` is the anonymous public catalog
 *     endpoint (marketing site + provider portal both render it to
 *     unauthenticated visitors), so no `AccessTokenGuard` runs and the
 *     interceptor cannot seed a scoped frame.
 *
 *   - `ApplicationsController.receiveWebhookEvent`
 *     (TS-020-followup-2b-platform-rollout) — `internal-checkr-webhook-dispatch`
 *     reason. `POST /api/v1/internal/providers/background-check-events` is
 *     the internal-only dispatch endpoint that `service-webhook` POSTs to
 *     after persisting a verified Checkr `report.*` event. The shared-
 *     secret header (`BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY`) is the
 *     auth model; no `AccessTokenGuard` runs.
 *
 *   - `ProviderDiscoveryController.getSnapshot`
 *     (TS-020-followup-2b-platform-rollout) — `internal-provider-discovery-snapshot`
 *     reason. `GET /api/v1/internal/providers/:providerId/discovery-snapshot`
 *     is the internal-only snapshot endpoint the
 *     `apps/workers/search-indexer` worker pulls from. The shared-secret
 *     header (`PROVIDER_DISCOVERY_INTERNAL_API_KEY`) is the auth model;
 *     no `AccessTokenGuard` runs.
 *
 *   - `CalendarSyncController.handleGoogleCallback` (TS-206) —
 *     `oauth-google-calendar-callback` reason. `GET /api/v1/providers/
 *     calendar/google/callback` is the Google OAuth redirect target — an
 *     unauthenticated browser redirect carrying no access token. The
 *     HMAC-signed `state` (CSRF + identity binding) is the auth model;
 *     no `AccessTokenGuard` runs, so the writes are wrapped in the
 *     exempt frame.
 *
 * Every other Prisma-touching surface sits behind `AccessTokenGuard`
 * (`ApplicationsController.submitApplication` /
 * `ApplicationsController.getMyApplication` /
 * `CertificationsController.getMyProfile` /
 * `.listMyCertifications` / `ProviderProfileController.getMySnapshot` /
 * `.updateProfile` / `ProviderPricingController.getMySnapshot` /
 * `.getById` / `.update`) or `AccessTokenGuard + PermissionGuard`
 * (`CertificationsController.grantCertification` /
 * `.revokeCertification` / `.evaluateTier` / `.overrideTier` /
 * `.getTierHistory`), so the interceptor seeds a scoped frame from
 * the access-token claims. `HealthController.readyz` is exempt by
 * construction — `prisma.ping()` routes to the BASE PrismaClient, not
 * the extended client, so the gate is never consulted (see
 * `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set).
 *
 * Future endpoints that land without `AccessTokenGuard` (e.g. additional
 * internal-webhook receivers, public read surfaces) MUST wrap their body
 * in `runWithoutTenantContext(this.tenantStore, '<reason>', ...)` with a
 * unique grep-able reason string — captured here so the convention has
 * a named home.
 *
 * `unscopedModels` covers the one platform-wide catalog in this schema
 * (`Certification`). The catalog defines what credentials Taste & See
 * recognises (CCC, ECC, specialty tracks); rows are not per-provider —
 * every provider reads the same catalog when rendering certs on their
 * profile or the public `GET /api/v1/certifications` surface. Per-
 * provider rows (`Provider`, `ProviderApplication`,
 * `ProviderBackgroundCheck`, `ProviderCertification`,
 * `ProviderTierHistory`, `ProviderProfileTag`,
 * `ProviderAvailabilityWindow`, `ProviderAvailabilityException`,
 * `ProviderServiceArea`, `OutboxEvent`) flow through the gate
 * normally.
 *
 * Env wiring. `IdempotencyModule.forRoot` needs `REDIS_URL` and the
 * TTL settings synchronously at module-definition time (the
 * module's dynamic shape depends on the backend mode). We call
 * `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in
 * `main.ts` / service-subscription / service-household. The result
 * is still re-validated by `AppConfigModule`'s factory provider so
 * downstream modules continue to consume `ENV_TOKEN` via DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-305a-followup-1 — @Global() shared audit emission. The three
    // provider:approve write paths (certification grant / revoke, tier move)
    // now emit an audit event inside their own transaction.
    AuditModule.forRoot({ producerService: 'service-provider' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-provider',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Platform-wide catalog with no tenant axis. `Certification` is
      // the same credential catalog every provider reads when rendering
      // certs on their profile or the public `GET /api/v1/certifications`
      // surface. Per-provider tables (`Provider`, `ProviderApplication`,
      // `ProviderBackgroundCheck`, `ProviderCertification`,
      // `ProviderTierHistory`, `ProviderProfileTag`, `OutboxEvent`) are
      // intentionally NOT in this list — those reads/writes still flow
      // through the gate.
      unscopedModels: ['Certification'],
    }),
    PrismaModule,
    HealthModule,
    // TS-050-followup-1 / TS-022-followup-3a-followup-1 — OpenTelemetry
    // tracing + Prometheus `/metrics` scrape endpoint + the global
    // HTTP-metrics interceptor, now via the shared
    // `@taste-and-see/nest-observability` package. The SDK init runs in
    // `src/observability/bootstrap.ts` (first import of `main.ts`); this
    // module wires the Nest-facing surface, with `serviceName` driving the
    // interceptor's meter name.
    ObservabilityModule.forRoot({ serviceName: 'service-provider' }),
    // TS-052-followup-11 + TS-080-followup-2 — `@taste-and-see/nest-auth`
    // provides `AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`,
    // collapsing the 13 verbatim per-service guard copies + the
    // service-provider-only RBAC guard into one shared package. The
    // forRoot options mirror the env contract the old guard injected
    // directly via `ENV_TOKEN`.
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
      serviceName: 'service-provider',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-142-followup-1 — wires the outbox producer SDK for
    // `provider.tier_changed` / `provider.certification_granted` /
    // `provider.certification_revoked` events emitted by TS-052-followup-1.
    // `schemaName` matches the Postgres schema that owns the
    // `outbox_events` table created in the
    // 20260516120000_outbox_events migration; the relay polls
    // `provider.outbox_events` by exact-match against this name.
    OutboxModule.forRoot({
      serviceName: 'service-provider',
      schemaName: 'provider',
    }),
    ApplicationsModule,
    CertificationsModule,
    ProviderDiscoveryModule,
    ProviderBillingContactsModule,
    ProfileModule,
    AvailabilityModule,
    ServiceAreasModule,
    PricingModule,
    CalendarSyncModule,
    DossierModule,
    DirectoryModule,
    MetricsModule,
    // TS-305d — service-provider's FIRST outbox-consumer surface. It has
    // been a producer since TS-050 and listened to nothing; the
    // `provider_metrics` read model is refreshed off service-booking's
    // lifecycle events, so building it made this service a consumer.
    //
    // The two dependency factories are handed to `forRoot` rather than
    // provided by `OutboxConsumersModule` (ADR-0005 / TS-506):
    // `OutboxConsumerService` is declared inside the SDK's own
    // `@Global()` module, so a provider declared in a feature module is
    // not in scope at its injection site and the process dies in the
    // injector at boot.
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-provider',
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
