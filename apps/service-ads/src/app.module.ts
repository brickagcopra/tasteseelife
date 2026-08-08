import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { AuditModule } from '@taste-and-see/nest-audit';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { CreativeReviewModule } from './modules/creative-review/creative-review.module';
import { SlotInventoryModule } from './modules/slot-inventory/slot-inventory.module';
import { SponsoredListingsModule } from './modules/sponsored-listings/sponsored-listings.module';
import { TargetingModule } from './modules/targeting/targeting.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Ads & promotions service composition root (TS-270 skeleton).
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — the skeleton
 *     scaffold (zod-validated env, tenant-scoped Prisma client, `/healthz`
 *     + `/readyz`).
 *   - `TenantContextModule` (global, TS-141) — wires the tenant-scoping SDK
 *     into the service so every DI-resolved Prisma operation flows through
 *     the gate.
 *
 * `TargetingModule` (TS-273) is wired here as the first non-skeleton module:
 * the server-side targeting evaluator (`TargetingService`) that decides
 * whether a campaign's persisted `ad_targeting_rules` match a delivery
 * audience. It carries NO HTTP surface of its own — it is consumed in-process
 * by the delivery path (TS-218 sponsored search slot / TS-275 capture) and
 * configured by the campaign admin UI (TS-271). So no `NestAuthModule` /
 * `IdempotencyModule` / JWT / Redis config arrives with it.
 *
 * `SponsoredListingsModule` (TS-218a) is the first HTTP surface: the internal
 * `POST /api/v1/internal/ads/sponsored-listings/resolve` endpoint
 * `service-search` calls to fill a sponsored search slot. It is a
 * service-to-service surface pinned by a shared-secret guard
 * (`ADS_INTERNAL_API_KEY`), NOT a user-JWT surface — so it still does not pull
 * in `NestAuthModule` / `IdempotencyModule` / JWT / Redis (those land with the
 * TS-271 campaign-admin write endpoints). All models it reads are unscoped, so
 * the tenant-scope gate short-circuits without a `runWithoutTenantContext`
 * frame (see the controller doc-block).
 *
 * `CampaignsModule` (TS-271a) is the first AUTHENTICATED HTTP surface — the
 * marketing-admin campaign-aggregate CRUD (create / list / detail / edit a
 * campaign with its creatives + targeting rules; advance a creative through its
 * review lifecycle), gated on `ads:read` / `ads:write` via
 * `@RequirePermissions(...)` + `PermissionGuard`. It is what pulls
 * `NestAuthModule` (the shared `AccessTokenGuard` wired from the env-sourced
 * JWT secret / issuer / audience) + `IdempotencyModule` (Redis-backed
 * `@Idempotent()` cache) into the composition root, and the JWT / Redis env
 * clusters arrive with it — mirroring the service-academy / service-concierge
 * shape. The skeleton carried no dead config until this surface landed (the
 * TS-070 service-messaging / TS-221 service-concierge convention).
 *
 * `SlotInventoryModule` (TS-272a) is the second authenticated surface — the
 * marketing-admin slot-scheduling tooling (read the seeded `ad_placements`;
 * book a campaign into a placement over a window via `ad_slot_schedules`),
 * gated on the same `ads:read` / `ads:write` permissions and riding the same
 * `NestAuthModule` + `IdempotencyModule` wiring `CampaignsModule` pulled in.
 *
 * `CreativeReviewModule` (TS-277a) is the third authenticated surface — the
 * creative approval workflow: the FIFO review queue, accessibility checks
 * (alt-text / WCAG contrast / motion / disclosure), and the approve / reject /
 * request-changes decision that snapshots an immutable `ad_creative_reviews`
 * row. The review endpoints are gated on the higher-trust
 * `marketing:approve_creative` (so the campaign author cannot self-approve); the
 * accessibility-metadata edit is the author's `ads:write`. Rides the same
 * `NestAuthModule` + `IdempotencyModule` wiring.
 *
 * The remaining authenticated / ingest surfaces (frequency capping TS-274,
 * impression / click capture TS-275, sponsored disclosure TS-278) land in
 * subsequent TS-27x slices on this same wiring.
 *
 * `TenantContextModule` enforcement: `enforce` (CLAUDE.md §3.2 + §17.10).
 * Every Prisma operation requires either an authenticated `RequestContext`
 * frame (seeded by `TenantContextInterceptor` from `request.requestContext`,
 * populated by `AccessTokenGuard` once it lands in TS-271) or an explicit
 * `runWithoutTenantContext('<reason>', ...)` exempt frame. Any unscoped query
 * is a hard `MissingRequestContextError`, not a log line — the loud-failure
 * posture CLAUDE.md §3.2 + §17.10 demand. The shape mirrors the canonical
 * wiring landed across every other Nest service; each service is a one-PR
 * mechanical mirror.
 *
 * `unscopedModels: ['AdCampaign', 'AdCreative', 'AdPlacement',
 * 'AdSlotSchedule', 'AdTargetingRule']`. Ads is a SYSTEMWIDE ad-management
 * surface (PRD §10.9) — campaigns, creatives, slot inventory + schedules, and
 * targeting rules are platform-wide marketing-admin-managed inventory with NO
 * per-household
 * tenant axis, exactly like service-subscription's `Plan` / `Coupon` catalog
 * or service-analytics' read-side marts. The advertiser axis
 * (`AdCampaign.advertiserId` — a soft FK that may point at a partner tenant,
 * a provider, or be null for an internal house ad) is NOT a request-context
 * tenant scope: these rows are administered by Marketing / Ops behind
 * `ads:write`, not by a household-scoped family token. So all six models are
 * declared unscoped and the TS-141 gate treats their reads/writes as
 * legitimately tenant-free. TS-277's creative approval workflow kept this
 * posture: the reviewer is Marketing staff behind `marketing:approve_creative`
 * (the `AdCreativeReview` decision log is platform-admin inventory), NOT a
 * partner_admin scoped to their own co-marketing creatives. Should a genuine
 * partner-tenant row-level boundary (a partner self-serve creative portal) ever
 * land, that surface revisits the scoping then — for the Phase-2 admin-managed
 * inventory, all six are platform catalog.
 *
 * Today no surface touches these models (they land with the TS-271+ admin
 * write endpoints); `HealthController` routes `prisma.ping()` to the BASE
 * PrismaClient via `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set, so
 * the gate is never consulted on the only live endpoints. When the TS-275
 * impression/click capture or any future internal ingest surface lands, any
 * non-`AccessTokenGuard` entrypoint MUST wrap its handler body in
 * `runWithoutTenantContext(this.tenantStore, '<reason>', ...)` with a unique,
 * grep-able reason string so the audit-log scan stays useful.
 *
 * Env wiring. `TenantContextModule.forRoot` needs configuration
 * synchronously at module-definition time. We call `loadEnv()` here once —
 * it's pure zod validation, idempotent against the same `process.env`, and
 * matches the pattern in `main.ts` / every other service's AppModule. The
 * result is still re-validated by `AppConfigModule`'s factory provider so
 * downstream modules continue to consume `ENV_TOKEN` via DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-303b-followup-1 — shared admin-mutation audit emission. @Global(),
    // so feature modules inject `AuditEmitter` without re-importing.
    AuditModule.forRoot({ producerService: 'service-ads' }),
    AppConfigModule,
    // TS-270-followup-1 — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor`
    // (meter `service-ads:http`). The tracing/metrics SDK init happens
    // earlier, in `src/observability/bootstrap.ts` (first import in
    // `main.ts`); by the time Nest builds this graph the global MeterProvider
    // is already wired. Domain counters (targeting evaluations, sponsored
    // resolve) fold in via TS-273-followup-1 / TS-218a observability.
    ObservabilityModule.forRoot({ serviceName: 'service-ads' }),
    TenantContextModule.forRoot({
      serviceName: 'service-ads',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Every model in the ads schema (`AdCampaign`, `AdCreative`,
      // `AdCreativeReview`, `AdPlacement`, `AdSlotSchedule`, `AdTargetingRule`)
      // is platform-wide marketing-admin inventory with no per-household tenant
      // axis — declared unscoped like service-subscription's `Plan` / `Coupon`
      // catalog. See the class doc-block for the advertiser-axis-vs-tenant-scope
      // rationale + the TS-277 partner-creative revisit note.
      unscopedModels: [
        'AdCampaign',
        'AdCreative',
        'AdCreativeReview',
        'AdPlacement',
        'AdSlotSchedule',
        'AdTargetingRule',
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
    IdempotencyModule.forRoot({
      environment: moduleEnv.NODE_ENV,
      serviceName: 'service-ads',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-271a-followup-1 / TS-272a-followup-1 / TS-277a-followup-1 — outbox
    // producer SDK (global). Each admin-mutation service injects `OutboxService`
    // and appends an `audit.action_recorded` row to `ads.outbox_events` INSIDE
    // the same `$transaction` as the state change, so the audit record commits
    // atomically with the mutation (PDD §7.3 / CLAUDE.md §5.3, §3.6). The
    // worker-outbox-relay drains the table onto Redis Streams; service-audit's
    // consumer persists append-only + hash-chained.
    OutboxModule.forRoot({ serviceName: 'service-ads', schemaName: 'ads' }),
    PrismaModule,
    HealthModule,
    TargetingModule,
    SponsoredListingsModule,
    CampaignsModule,
    SlotInventoryModule,
    CreativeReviewModule,
  ],
})
export class AppModule {}
