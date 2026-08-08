import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { EmergencyContactsModule } from './modules/emergency-contacts/emergency-contacts.module';
import { HouseholdAccessModule } from './modules/household-access/household-access.module';
import { HouseholdMembershipsModule } from './modules/household-memberships/household-memberships.module';
import { IntakeModule } from './modules/intake/intake.module';
import { MemoryRecipesModule } from './modules/memory-recipes/memory-recipes.module';
import { SeniorAlertPreferencesModule } from './modules/senior-alert-preferences/senior-alert-preferences.module';
import { SeniorConsentModule } from './modules/senior-consent/senior-consent.module';
import { SeniorProfileModule } from './modules/senior-profile/senior-profile.module';
import { SeniorsDirectoryModule } from './modules/seniors-directory/seniors-directory.module';
import { VisitPrepModule } from './modules/visit-prep/visit-prep.module';
import { WellnessSummaryModule } from './modules/wellness-summary/wellness-summary.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Household service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-030 skeleton.
 *   - `IntakeModule` — TS-031 senior intake form (field-level encrypted
 *     PII payload + operational tag columns).
 *   - `EmergencyContactsModule` — TS-032 household-scoped contacts roster
 *     (plain-column storage; service-layer cap of 10 per household).
 *   - `HouseholdAccessModule` — TS-032 encrypted household-access
 *     instructions (door code / alarm code / key location etc).
 *   - `MemoryRecipesModule` — TS-033 per-senior catalog of culturally
 *     meaningful dishes (plain-column storage; service-layer cap of
 *     200 recipes per senior).
 *   - `SeniorProfileModule` — TS-033 senior memory profile key/value
 *     store (favourite-childhood-food, regional-tradition, comfort-food
 *     cues; plain-column storage; service-layer cap of 64 entries
 *     per senior).
 *   - `SeniorsDirectoryModule` — TS-214 `GET /api/v1/me/seniors`
 *     resolver. Maps an authenticated user to the active seniors in the
 *     households they belong to — the family-portal entry point into
 *     the per-senior surfaces above (read-only; no migration).
 *   - `IdempotencyModule` (global) — TS-044-followup-1 Redis-backed
 *     Idempotency-Key replay cache covering every controller method
 *     flagged with `@Idempotent()`. Closes TS-031-followup-1,
 *     TS-032-followup-1, TS-033-followup-1 in lockstep.
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
 *   - `OutboxModule` (global) — TS-142-followup-1. Wires the outbox
 *     producer SDK so household-side producers (senior intake /
 *     emergency-contact / access-instructions / memory-recipe /
 *     senior-preferences change events — TS-031/-032/-033-followup-2)
 *     can append domain events transactionally with their state change.
 *     The table + SDK ship ahead of the per-event producer follow-ups.
 *
 * Future domain modules — invitations & member management
 * (TS-121-adjacent) — slot in under `src/modules/` per the standard
 * layout in PDD §7.1.
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
 * TS-020-followup-2 / -2a / -2a2 / -2b and the first downstream rollout
 * in `service-subscription`; each downstream service is a one-PR
 * mechanical mirror.
 *
 * Token-guarded surfaces. Every family-/senior-facing controller in this
 * service (`IntakeController`, `EmergencyContactsController`,
 * `HouseholdAccessController`, `MemoryRecipesController`,
 * `SeniorPreferencesController`, `SeniorConsentController`,
 * `SeniorAlertPreferencesController`, `SeniorsDirectoryController`)
 * requires a Bearer access token via `@UseGuards(AccessTokenGuard)`, so
 * the `TenantContextInterceptor` always seeds a scoped frame from the
 * access-token claims before the handler runs. `HealthController.readiness`
 * is exempt by construction — `prisma.ping()` routes to the BASE
 * PrismaClient via `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH`
 * set, so the gate is never consulted.
 *
 * Internal exempt surfaces. Two shared-secret-pinned internal endpoints
 * run BEFORE any `requestContext` exists, so each wraps its handler body
 * in `runWithoutTenantContext(this.tenantStore, '<reason>', ...)` with a
 * unique, grep-able reason string:
 *   - `VisitPrepInternalController` (TS-208) — reason
 *     `internal-visit-prep-snapshot`.
 *   - `WellnessSummaryInternalController` (TS-235) — reason
 *     `internal-wellness-summary-households`.
 *   - `HouseholdMembershipsInternalController` (TS-505d2-followup-5) —
 *     reason `internal-household-memberships`. The exempt frame is
 *     structurally required here rather than merely convenient: this
 *     route is what ESTABLISHES a caller's household scope, so it cannot
 *     itself run inside one.
 * If a future endpoint lands without `AccessTokenGuard` (e.g. an inbound
 * provider webhook or a public sharing surface), it MUST follow the same
 * pattern so the audit-log scan stays useful.
 *
 * `unscopedModels` is the empty list. Every model in this service
 * (`Household`, `HouseholdMember`, `Senior`, `EmergencyContact`,
 * `MemoryRecipe`, `SeniorPreference`, `SeniorConsent`) is per-household
 * / per-senior —
 * there is no platform-wide catalog table here. Every read and write
 * is bound to a household via the `requestContext.tenantScope` seeded
 * by `AccessTokenGuard`. Note where that scope actually comes from
 * (TS-505d2-followup-5): NOT from the access token, which has only ever
 * carried `global`, but from the api-gateway, which resolves the caller's
 * active memberships through `HouseholdMembershipsInternalController`
 * below and signs the result into the `x-ts-trust-*` envelope. A direct
 * bearer caller therefore still arrives `global`-scoped — one more reason
 * the gateway is the only supported ingress. `OutboxEvent`
 * is deliberately NOT in this list either — the outbox SDK writes via
 * raw SQL inside the caller's `$transaction`, so the gate's model-level
 * check never intercepts it (same posture as service-identity /
 * service-provider).
 *
 * Env wiring. `IdempotencyModule.forRoot` + `TenantContextModule.forRoot`
 * both need configuration synchronously at module-definition time. We
 * call `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in `main.ts` /
 * service-subscription's AppModule. The result is still re-validated by
 * `AppConfigModule`'s factory provider so downstream modules continue
 * to consume `ENV_TOKEN` via DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-household:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-household' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-household',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Every model in the household schema is per-household / per-senior
      // — there is no platform-wide catalog table. Reads and writes all
      // bind to a household via the `requestContext.tenantScope` seeded
      // by `AccessTokenGuard`.
      unscopedModels: [],
    }),
    PrismaModule,
    HealthModule,
    // TS-052-followup-11a — `@taste-and-see/nest-auth` provides
    // `AccessTokenGuard` for the intake / emergency-contacts / household-
    // access / memory-recipes / senior-preferences endpoints. Same env
    // contract the local guard used (TS-031/-032/-033) — only the import
    // path + DI wiring changed; verification semantics are identical.
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
      serviceName: 'service-household',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-142-followup-1 — wires the outbox producer SDK so household-side
    // producers (senior intake / emergency-contact / access-instructions /
    // memory-recipe / senior-preferences change events —
    // TS-031/-032/-033-followup-2) can append domain events transactionally
    // with their state change. `schemaName` matches the Postgres schema that
    // owns the `outbox_events` table created in the 20260608120000_outbox_events
    // migration; the relay polls `household.outbox_events` by exact-match
    // against this name. The table + SDK ship ahead of the per-event producer
    // follow-ups so the migration review stays decoupled (one reviewable
    // migration per service). The SDK writes via raw SQL inside the caller's
    // `$transaction`, so the TenantContext gate's model-level check never
    // intercepts it — `OutboxEvent` deliberately stays out of `unscopedModels`
    // (mirrors service-identity / service-provider's wiring).
    OutboxModule.forRoot({
      serviceName: 'service-household',
      schemaName: 'household',
    }),
    IntakeModule,
    EmergencyContactsModule,
    HouseholdAccessModule,
    HouseholdMembershipsModule,
    MemoryRecipesModule,
    SeniorProfileModule,
    SeniorConsentModule,
    SeniorAlertPreferencesModule,
    SeniorsDirectoryModule,
    VisitPrepModule,
    WellnessSummaryModule,
  ],
})
export class AppModule {}
