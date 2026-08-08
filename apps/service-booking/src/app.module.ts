import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { BullMqSchedulerModule } from '@taste-and-see/nest-bullmq-scheduler';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { BookingMetricsModule } from './observability/booking-metrics.module';
import { AdminModule } from './modules/admin/admin.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CheckInsModule } from './modules/check-ins/check-ins.module';
import { ConciergeModule } from './modules/concierge/concierge.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { LifecycleModule } from './modules/lifecycle/lifecycle.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { RecurrenceModule } from './modules/recurrence/recurrence.module';
import { AnomalyModule } from './modules/anomaly/anomaly.module';
import { SubjectHoldsModule } from './modules/subject-holds/subject-holds.module';
import { TierGatingModule } from './modules/tier-gating/tier-gating.module';
import { VisitNotesModule } from './modules/visit-notes/visit-notes.module';
import { WellnessAnomalyModule } from './modules/wellness-anomaly/wellness-anomaly.module';
import { WellnessObservationSummaryModule } from './modules/wellness-observation-summary/wellness-observation-summary.module';
import { WellnessTrendsModule } from './modules/wellness-trends/wellness-trends.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Booking service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-060
 *     skeleton.
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
 *   - `LifecycleModule` — TS-060 booking lifecycle state machine
 *     (`BookingLifecycleService`). Pure logic; consumed by
 *     `BookingsService` for transition validation.
 *   - `IdempotencyModule` (global) — TS-060-followup-1 Redis-backed
 *     Idempotency-Key replay cache covering every controller method
 *     flagged with `@Idempotent()`.
 *   - `OutboxModule` (global) — TS-060-followup-1 outbox producer
 *     SDK (`@taste-and-see/nest-outbox`); `BookingsService` injects
 *     `OutboxService` and appends `booking.*` events transactionally
 *     with the row mutation.
 *   - `BookingsModule` — TS-060-followup-1 authenticated REST
 *     surface for booking create / status transition / read.
 *
 *   - `RecurrenceModule` — TS-061 RRULE-driven recurring bookings.
 *     One endpoint (`POST /api/v1/bookings/recurring`); the service
 *     explodes a Phase-1 RRULE subset (FREQ=WEEKLY|MONTHLY +
 *     INTERVAL + COUNT|UNTIL) into per-occurrence `bookings` rows and
 *     one `booking_recurrence` row, capped at 52 occurrences, inside
 *     a single Prisma `$transaction`.
 *
 *   - `VisitNotesModule` — TS-062 wellness observation notes per
 *     visit. Two endpoints under
 *     `/api/v1/bookings/:bookingId/visit-notes`: PUT upsert (idempotent
 *     on `Idempotency-Key`, gated on booking lifecycle status) + GET
 *     read. Drives the family peace-of-mind dashboard (PRD §6.4) and
 *     the monthly wellness summary email (PRD §6.9).
 *
 *   - `CheckInsModule` — TS-063 geo check-in / check-out. Two
 *     endpoints under `/api/v1/bookings/:bookingId/check-ins`: POST
 *     record (idempotent on `Idempotency-Key`, atomically transitions
 *     the booking lifecycle status + emits `booking.in_progress` /
 *     `booking.completed`) + GET list. Drives PRD §6.4 family
 *     peace-of-mind ("provider arrived") and PRD §7.4 provider visit
 *     workflow.
 *
 *   - `DisputesModule` — TS-065 booking dispute workflow (PRD §10.5).
 *     Four endpoints: POST open, GET list, GET single, PATCH update.
 *     Multiple disputes per booking permitted; the service emits
 *     `booking.dispute_opened` on file and `booking.dispute_resolved`
 *     on terminal transition (resolved / dismissed) atomically with
 *     the row mutation inside one Prisma `$transaction`. Welfare
 *     concerns route through the same surface — first-class per
 *     CLAUDE.md §12.
 *
 *   - `DashboardModule` — TS-230 family peace-of-mind dashboard read
 *     aggregate. One endpoint (`GET /api/v1/bookings/dashboard/me`)
 *     resolving the household from the token `tenantScope`: the
 *     window-bounded (7 / 30 / 90 days) upcoming-visit list + the
 *     cursor-paginated completed-visit history with visit-note
 *     summaries inlined (one batched read — no N+1). Read-only; drives
 *     PRD §6.4 family peace-of-mind.
 *
 *   - `WellnessTrendsModule` — TS-231 per-senior wellness-trend read
 *     aggregate. One endpoint
 *     (`GET /api/v1/bookings/seniors/:seniorId/wellness-trends`)
 *     resolving the household from the token `tenantScope`: per-visit
 *     mood / appetite / hydration / social-engagement series over a
 *     30 / 90-day window (batched visit-note read — no N+1). The
 *     gateway BFF applies the senior's `notes` consent gate (TS-238).
 *     Read-only; drives PRD §6.4 / §6.9.
 *
 *   - `WellnessAnomalyModule` — TS-236 wellness-anomaly early-warning
 *     read. One endpoint
 *     (`GET /api/v1/bookings/seniors/:seniorId/wellness-anomalies`)
 *     reusing `WellnessTrendsService`'s per-visit series + the shared
 *     `detectWellnessAnomalies` EWMA decline detector. Flags scales that
 *     have slipped relative to the senior's own recent baseline. Same
 *     household scope + gateway `notes` consent gate as the trends.
 *     Read-only; drives PRD §6.9.
 *
 *   - `WellnessObservationSummaryModule` — TS-235 internal wellness-
 *     observation-summary read for the monthly wellness-summary worker.
 *     One shared-secret-pinned endpoint
 *     (`GET /api/v1/internal/bookings/households/:householdId/seniors/
 *     :seniorId/wellness-observation-summary`) reusing
 *     `WellnessTrendsService`'s per-visit series and collapsing each
 *     scale into the compact latest + mean + count roll-up the email
 *     carries. `householdId` rides in the path (no token to derive it
 *     from). Read-only; drives PRD §6.4 / §6.9.
 *
 *   - `TierGatingModule` — TS-064 provider-tier gating cache + gate
 *     evaluator (PRD §5.1 / §5.2; CLAUDE.md §12). Maintains read-side
 *     snapshots of household + provider tier so `BookingsService.createBooking`
 *     can enforce "Tier-3 Concierge households can only book Elite
 *     Concierge providers" at the service layer. Two internal POST
 *     endpoints (shared-secret pinned) hydrate the cache; the event-
 *     driven path lands with TS-142.
 *
 *   - `AnomalyModule` — TS-308a impossible-travel detection over
 *     provider check-ins. Service-booking's first BullMQ queue; the
 *     sweep emits `booking.anomaly.impossible_travel` and
 *     service-trust-safety opens the incident.
 *   - `SubjectHoldsModule` — TS-304 trust & safety booking holds
 *     (PRD §10.14; PDD §16.1; CLAUDE.md §12). Owns what "held" means to
 *     a booking: the per-row `held_by_incident_id` marker, the
 *     per-(incident, subject) `booking_subject_holds` authority, and the
 *     pre-flight screen `BookingsService.createBooking` /
 *     `RecurrenceService.createRecurringSeries` consult before writing.
 *     No controller — a hold originates from a trust & safety incident
 *     and is lifted by the review committee closing it, never from a
 *     booking-side endpoint.
 *
 *   - `OutboxConsumerModule` (global) + `OutboxConsumersModule` — TS-304.
 *     **Service-booking's first CONSUMER surface**; it was producer-only
 *     through TS-303. Subscribes to the trust & safety hold pair
 *     (`trust_safety.booking_hold.requested` / `.released`) on Redis
 *     Streams. An event rather than an authenticated inbound call
 *     because an incident must not fail to open when this service is
 *     down, and the hold has to survive a redelivery (CLAUDE.md §5.3).
 *     Orthogonal to the PRODUCER `OutboxModule` above; the two dedup
 *     tables (`booking.outbox_events` vs
 *     `booking.outbox_consumer_dedup`) are different tables.
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
 * Pre-auth + internal exempt surfaces in service-booking:
 *
 *   - `TierGatingController.upsertHouseholdSnapshot`
 *     (TS-020-followup-2b-platform-rollout) —
 *     `internal-tier-snapshot-household-upsert` reason.
 *     `POST /api/v1/internal/booking/tier-snapshots/household` is the
 *     internal-only dispatch endpoint that ops / the gateway BFF (and,
 *     post-TS-142, the `subscription.tier_changed` event consumer)
 *     POSTs to. The shared-secret header
 *     (`BOOKING_TIER_DISPATCH_API_KEY`) is the auth model; no
 *     `AccessTokenGuard` runs.
 *
 *   - `TierGatingController.upsertProviderSnapshot`
 *     (TS-020-followup-2b-platform-rollout) —
 *     `internal-tier-snapshot-provider-upsert` reason. Mirror endpoint
 *     for providers; same shared-secret pinning + lack of
 *     `AccessTokenGuard`.
 *
 *   - `WellnessObservationSummaryController.getSummary` (TS-235) —
 *     `internal-wellness-observation-summary` reason.
 *     `GET /api/v1/internal/bookings/households/:householdId/seniors/
 *     :seniorId/wellness-observation-summary` is the internal-only read
 *     the monthly wellness-summary worker calls. The shared-secret header
 *     (`BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY`) is the auth model; no
 *     `AccessTokenGuard` runs.
 *
 *   - `OutboxConsumersModule`'s two handlers (TS-304) —
 *     `outbox-consumer-trust-safety-booking-hold-requested` /
 *     `outbox-consumer-trust-safety-booking-hold-released` reasons. The
 *     consumer SDK invokes handlers from a background poll loop, not an
 *     HTTP request, so there is no `request.requestContext` to seed a
 *     scoped frame from; each registration wraps its dispatch in
 *     `runWithoutTenantContext`. A hold is inherently cross-tenant by
 *     design — a provider hold suspends bookings across every household
 *     that provider serves, which is the whole point — so the exemption
 *     is confined to the two hold operations rather than opened up as a
 *     general unscoped surface.
 *
 * Every other Prisma-touching surface sits behind `AccessTokenGuard`
 * (`BookingsController.*`, `RecurrenceController.*`,
 * `VisitNotesController.*`, `CheckInsController.*`, `DisputesController.*`,
 * `ConciergeRequestsController.*`, `FamilyDashboardController.getMyDashboard`)
 * or `AccessTokenGuard + SuperAdminRoleGuard` (`AdminBookingsController.*`),
 * so the interceptor seeds a scoped frame from the access-token claims. `HealthController.readiness`
 * is exempt by construction — `prisma.ping()` routes to the BASE
 * PrismaClient, not the extended client, so the gate is never consulted
 * (see `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set).
 *
 * Future endpoints that land without `AccessTokenGuard` (e.g. additional
 * internal dispatch receivers, public read surfaces) MUST wrap their body
 * in `runWithoutTenantContext(this.tenantStore, '<reason>', ...)` with a
 * unique grep-able reason string — captured here so the convention has
 * a named home.
 *
 * `unscopedModels` is empty: every model in the booking schema is per-
 * household, per-provider, or per-booking (which is per-household/per-
 * provider by inheritance). There is no platform-wide catalog in this
 * schema (contrast with `service-provider`'s `Certification` table —
 * the same credential catalog every provider reads). The two tier-
 * snapshot tables (`HouseholdTierSnapshot`, `ProviderTierSnapshot`) are
 * keyed per-household and per-provider respectively; the upsert path
 * runs inside the `internal-tier-snapshot-*-upsert` exempt frames
 * documented above, not as platform-wide catalog reads.
 *
 * Env wiring. `IdempotencyModule.forRoot` and `OutboxModule.forRoot`
 * both consume the validated `Env` at module-definition time (the
 * dynamic module shape depends on the resolved options). We call
 * `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in
 * `main.ts` / service-provider / service-subscription. The result is
 * still re-validated by `AppConfigModule`'s factory provider so
 * downstream modules continue to consume `ENV_TOKEN` via DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-booking',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // `ServiceCatalogEntry` (TS-060-followup-2) is platform-wide
      // pricing/duration metadata — it carries no tenant column, so it
      // is unscoped (the tenant-scope extension would otherwise reject
      // a query that doesn't carry a tenant filter). Every OTHER model
      // in the booking schema is per-household, per-provider, or
      // per-booking. The two tier-snapshot tables are keyed
      // per-household / per-provider; their upsert path runs inside
      // `internal-tier-snapshot-*-upsert` exempt frames.
      unscopedModels: ['ServiceCatalogEntry'],
    }),
    PrismaModule,
    HealthModule,
    // TS-060-followup-4 — OpenTelemetry tracing + the Prometheus `/metrics`
    // scrape endpoint + the global HTTP-metrics interceptor, via the shared
    // `@taste-and-see/nest-observability` package. The SDK init runs in
    // `src/observability/bootstrap.ts` (first import of `main.ts`); this
    // module wires the Nest-facing surface, with `serviceName` driving the
    // interceptor's meter name. Mirrors service-provider (TS-050-followup-1).
    ObservabilityModule.forRoot({ serviceName: 'service-booking' }),
    // TS-060-followup-4 — service-local global module exposing the domain
    // `BookingMetrics` instruments (`booking_created_total`,
    // `booking_status_transition_total`, `booking_completion_total`,
    // `booking_cancellation_total`) injected by `BookingsService`. Domain
    // counters stay service-local; the shared package owns only the
    // boilerplate scrape + interceptor. Mirrors service-webhook's
    // `WebhookMetricsModule` (TS-041a-followup-4).
    BookingMetricsModule,
    // TS-052-followup-11a — wires the shared `@taste-and-see/nest-auth`
    // package. Replaces the per-service `common/guards/access-token.guard.ts`
    // copy. Same env contract (JWT_ACCESS_SECRET / JWT_ISSUER / JWT_AUDIENCE)
    // that the local guard validated; only the import path + DI wiring
    // changed. Service-booking is the fifth consumer after service-provider
    // (canonical), service-identity, service-household, and service-subscription.
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
      serviceName: 'service-booking',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    OutboxModule.forRoot({
      serviceName: moduleEnv.OUTBOX_PRODUCER_SERVICE,
      schemaName: 'booking',
    }),
    // TS-304 — the CONSUMER half. `consumerGroup` is the service name so
    // the relay's per-group pending-entry accounting matches the pod set.
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-booking',
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
    // TS-308a-followup-1 — the in-service BullMQ sweep scheduler, extracted
    // once its skeleton reached a third copy. Owns the REDIS_URL
    // decomposition, the CLAUDE.md §3.7 key prefix
    // (`{env}:service-booking:queue`) and the shutdown drain for the
    // TS-308a/TS-308c anomaly sweep. `@Global()`, so `AnomalyModule` does
    // not import it. Options are validated at module-definition time — a
    // bad REDIS_URL fails the boot rather than the first tick, which would
    // otherwise be silent.
    BullMqSchedulerModule.forRoot({
      serviceName: 'service-booking',
      environment: moduleEnv.NODE_ENV,
      redisUrl: moduleEnv.REDIS_URL,
    }),
    LifecycleModule,
    SubjectHoldsModule,
    TierGatingModule,
    BookingsModule,
    CatalogModule,
    ConciergeModule,
    RecurrenceModule,
    VisitNotesModule,
    CheckInsModule,
    DisputesModule,
    DashboardModule,
    WellnessTrendsModule,
    WellnessAnomalyModule,
    WellnessObservationSummaryModule,
    AdminModule,
    // TS-304 — registered last so its `onModuleInit` handler registration
    // runs after every module it dispatches into is resolvable.
    OutboxConsumersModule,
    AnomalyModule,
  ],
})
export class AppModule {}
