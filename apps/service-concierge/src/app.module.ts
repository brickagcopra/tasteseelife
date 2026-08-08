import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { PagerDutyModule } from '@taste-and-see/nest-pagerduty';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { EmergencyModule } from './modules/emergency/emergency.module';
import { EnrichmentModule } from './modules/enrichment/enrichment.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OpsConsoleModule } from './modules/ops-console/ops-console.module';
import { ScheduledEventsModule } from './modules/scheduled-events/scheduled-events.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { TransportationModule } from './modules/transportation/transportation.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Concierge service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-221
 *     skeleton.
 *   - `TenantContextModule` (global) — TS-141. Wires the tenant-scoping
 *     SDK into the service so every DI-resolved Prisma operation flows
 *     through the gate.
 *
 * Modules registered here (TS-222):
 *   - `AssignmentsModule` — TS-222 dedicated culinary-concierge
 *     assignment for Tier 3 households (`POST /api/v1/concierge/
 *     assignments` + family `/me` read + admin history + end). The first
 *     authenticated HTTP surface, which is why `NestAuthModule`
 *     (AccessTokenGuard) + `IdempotencyModule` register here and the JWT /
 *     Redis env clusters arrive — mirroring the service-household /
 *     service-subscription shape.
 *   - `NestAuthModule` (global) — TS-222. Wires the shared
 *     `AccessTokenGuard` from the env-sourced JWT secret / issuer /
 *     audience.
 *   - `IdempotencyModule` (global) — TS-222. Redis-backed Idempotency-Key
 *     cache covering every controller method flagged with `@Idempotent()`.
 *
 * Modules registered here (TS-223):
 *   - `TicketsModule` — TS-223 family-side concierge custom-request /
 *     service-request submission (`POST /api/v1/concierge/requests`) + the
 *     family `/me` list. Both behind `AccessTokenGuard` (household-scoped),
 *     reusing the JWT + idempotency wiring TS-222 brought.
 *
 * Modules registered here (TS-224):
 *   - `OpsConsoleModule` — the internal-staff ops console for the concierge
 *     ticket queue (`GET /api/v1/admin/concierge/tickets` SLA-ordered queue +
 *     `:ticketId` detail-with-notes read; `:ticketId/transition`,
 *     `:ticketId/escalate`, `:ticketId/notes` mutations). Gated on
 *     `concierge:read` / `concierge:write` via `@RequirePermissions(...)` +
 *     `PermissionGuard` (the first service to adopt the lifted permission
 *     guard rather than the local `SuperAdminRoleGuard`). Adds the
 *     `concierge_ticket_notes` table (internal-notes timeline).
 *
 * Modules registered here (TS-227):
 *   - `ScheduledEventsModule` — the concierge fulfilment surface for event
 *     dining + social outings (`GET/POST /api/v1/admin/concierge/scheduled-events`
 *     + `PATCH :eventId`). Gated on `concierge:read` / `concierge:write`
 *     (reusing the permissions TS-224 added — no RBAC catalog change). Adds the
 *     `concierge_scheduled_events` table (optional in-service FK to
 *     `concierge_tickets`). `externalProvider` is the Phase-3 OpenTable / museum
 *     adapter seam (Phase-1 default `manual`).
 *
 * Modules registered here (TS-225):
 *   - `EmergencyModule` — the family-side emergency concierge-assistance
 *     surface (`POST /api/v1/concierge/emergency`). Behind `AccessTokenGuard`
 *     (household-scoped), reusing the JWT + idempotency wiring TS-222 brought.
 *     Opens a high-severity `emergency_assistance` ticket (escalated on the
 *     `emergency_on_call` path, 1-hour SLA) and pages the on-call supervisor
 *     via PagerDuty (best-effort; the optional `PAGERDUTY_*` env cluster).
 *
 * Modules registered here (TS-228):
 *   - `OnboardingModule` — the Tier-3 white-glove kickoff checklist
 *     (`POST/GET/PATCH /api/v1/admin/concierge/onboardings` + `PATCH
 *     :onboardingId/steps/:stepKey` + the household-scoped family read `GET
 *     /api/v1/concierge/onboarding/me`). The admin surfaces gate on
 *     `concierge:read` / `concierge:write` (reusing the TS-224 permissions — no
 *     RBAC catalog change). Adds the `concierge_onboardings` +
 *     `concierge_onboarding_steps` tables (the second carries the household
 *     axis, so `unscopedModels` stays empty).
 *
 * Modules registered here (TS-226):
 *   - `TransportationModule` — the concierge transportation-coordination
 *     surface (`GET/POST /api/v1/admin/concierge/transportation` + `PATCH
 *     :requestId`) gated on `concierge:read` / `concierge:write` (reusing the
 *     TS-224 permissions — no RBAC catalog change), PLUS the FIRST
 *     non-`AccessTokenGuard` surface in this service: the shared-secret-pinned
 *     inbound ride-status webhook (`POST
 *     /internal/concierge/transportation/ride-events`). Adds the
 *     `concierge_transportation_requests` table (optional in-service FK to
 *     `concierge_tickets`). `externalProvider` is the Phase-3 Uber Health /
 *     Lyft Health adapter seam (Phase-1 default `manual`); no external SDK is
 *     imported (TS-226-followup carries the live integration + its SDK ADR).
 *
 * Modules registered here (TS-229):
 *   - `EnrichmentModule` — the Tier-3 weekly enrichment summary (`POST/GET/PATCH
 *     /api/v1/admin/concierge/enrichment-summaries` + the household-scoped
 *     family reads `GET /api/v1/concierge/enrichment-summaries/me` +
 *     `.../me/:summaryId`). The admin surfaces gate on `concierge:read` /
 *     `concierge:write` (reusing the TS-224 permissions — no RBAC catalog
 *     change). Adds the `concierge_enrichment_summaries` table (one Monday-keyed
 *     summary per household per week; draft → published → archived; the family
 *     sees only published). Email-on-publish via service-notification is a
 *     deferred follow-up (service-concierge has no outbox yet).
 *
 * `TenantContextModule` (global, TS-141). Wires a request-scoped
 * `AsyncLocalStorage` store, an interceptor that seeds the store from
 * `request.requestContext` (populated by `AccessTokenGuard` once it
 * lands in TS-222), and the tokens the Prisma extension consumes when
 * `PrismaModule`'s factory wraps `PrismaService` with the gate
 * (`wrapWithTenantScope`).
 *
 * Enforcement: `enforce` (TS-141). Every Prisma operation requires
 * either an authenticated `RequestContext` frame (seeded by
 * `TenantContextInterceptor` from `request.requestContext`) or an
 * explicit `runWithoutTenantContext('<reason>', ...)` exempt frame. Any
 * unscoped query is a hard `MissingRequestContextError`, not a log line —
 * the loud-failure posture CLAUDE.md §3.2 + §17.10 demand. The shape
 * mirrors the canonical wiring landed across service-identity /
 * service-household / service-subscription; each service is a one-PR
 * mechanical mirror.
 *
 * Internal exempt surfaces in service-concierge (TS-226): the inbound
 * ride-status webhook `TransportationWebhookController.receive`
 * (`POST /internal/concierge/transportation/ride-events`) is the ONLY
 * surface NOT behind `AccessTokenGuard` — a ride-hailing vendor edge does
 * not log in, so it is pinned by `TransportationSharedSecretGuard` instead
 * and wraps its handler body in
 * `runWithoutTenantContext(this.tenantStore, 'internal-transportation-ride-event', ...)`.
 * Every OTHER Prisma-touching HTTP surface sits behind `AccessTokenGuard`
 * (the `AssignmentsController` + `TicketsController` + `OpsConsoleController`
 * + `EmergencyController` + `EnrichmentController` + `TransportationController`
 * endpoints — the ops console + scheduled-events + transportation + enrichment
 * admin surfaces additionally layer `PermissionGuard`), so the
 * `TenantContextInterceptor` seeds a scoped frame
 * from the access-token claims before the handler runs. `HealthController` (`/healthz` +
 * `/readyz`) is exempt by construction — `prisma.ping()` routes to the
 * BASE PrismaClient via `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH`
 * set, so the gate is never consulted. If a future endpoint lands
 * without `AccessTokenGuard` (e.g. an inbound webhook or a public
 * sharing surface), it MUST wrap its handler body in
 * `runWithoutTenantContext(this.tenantStore, '<reason>', ...)` with a
 * unique, grep-able reason string so the audit-log scan stays useful.
 *
 * `unscopedModels` is the empty list. Every model in this service
 * (`ConciergeTicket`, `ConciergeAssignment`, `ConciergeTicketNote`,
 * `ConciergeScheduledEvent`, `ConciergeOnboarding`,
 * `ConciergeOnboardingStep`, `ConciergeEnrichmentSummary`,
 * `ConciergeTransportationRequest`) is per-household —
 * there is no platform-wide
 * catalog table here. The note + scheduled-event rows carry their own
 * `household_id` so they carry the household axis like the rest. Every read and write binds to a
 * household via the `requestContext.tenantScope` seeded by
 * `AccessTokenGuard` (the family access token carries a
 * `tenantScope: {type: 'household', householdId}` claim; the admin token
 * carries a `global` scope — both seed a frame, which is all today's gate
 * requires; row-level filtering is the service's responsibility).
 *
 * Env wiring. `TenantContextModule.forRoot` needs configuration
 * synchronously at module-definition time. We call `loadEnv()` here once
 * — it's pure zod validation, idempotent against the same `process.env`,
 * and matches the pattern in `main.ts` / every other service's
 * AppModule. The result is still re-validated by `AppConfigModule`'s
 * factory provider so downstream modules continue to consume `ENV_TOKEN`
 * via DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-concierge:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-concierge' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-concierge',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Every model in the concierge schema (`ConciergeTicket`,
      // `ConciergeAssignment`, `ConciergeTicketNote`) is per-household —
      // there is no platform-wide catalog table. Reads and writes all bind
      // to a household via the `requestContext.tenantScope` seeded by
      // `AccessTokenGuard`.
      unscopedModels: [],
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
      serviceName: 'service-concierge',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-302b — the emergency on-call pager, extracted from this service to
    // `@taste-and-see/nest-pagerduty`. `source` is required by the package
    // (it stamps `payload.source`, naming the emitter in the responder's
    // timeline); the env still carries the per-service default. Options are
    // validated here at module-definition time, so a bad endpoint or timeout
    // fails the boot rather than the page.
    PagerDutyModule.forRoot({
      source: moduleEnv.PAGERDUTY_SOURCE,
      routingKey: moduleEnv.PAGERDUTY_ROUTING_KEY,
      eventsUrl: moduleEnv.PAGERDUTY_EVENTS_URL,
      timeoutMs: moduleEnv.PAGERDUTY_TIMEOUT_MS,
    }),
    PrismaModule,
    HealthModule,
    AssignmentsModule,
    TicketsModule,
    OpsConsoleModule,
    ScheduledEventsModule,
    EmergencyModule,
    OnboardingModule,
    EnrichmentModule,
    TransportationModule,
  ],
})
export class AppModule {}
