import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { ConnectModule } from './modules/connect/connect.module';
import { DisbursementsModule } from './modules/disbursements/disbursements.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Payouts service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-090
 *     skeleton.
 *   - `NestAuthModule` — TS-052-followup-11a shared `@taste-and-see/nest-auth`
 *     wiring (`AccessTokenGuard` + `PermissionGuard` + `@RequirePermissions`).
 *     Replaces the per-service `common/guards/access-token.guard.ts`
 *     copy. Service-payouts is the tenth consumer after
 *     service-provider (canonical), service-identity, service-household,
 *     service-subscription, service-booking, service-accounting,
 *     service-audit, service-activity, and service-notification.
 *   - `ConnectModule` — TS-090 Stripe Connect Express onboarding
 *     surface (provider self-service create-or-fetch + onboarding link
 *     issuance + admin read + shared-secret-pinned `account.updated`
 *     ingest from service-webhook).
 *   - `DisbursementsModule` — TS-091 disbursement surface (admin sweep
 *     trigger + manual scheduling + execute / cancel; provider self-
 *     service history; shared-secret-pinned `transfer.paid` /
 *     `transfer.failed` ingest).
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
 * Pre-auth + internal exempt surfaces in service-payouts:
 *
 *   - `StripeEventsController.ingest` — `internal-stripe-account-event`
 *     reason. `POST /api/v1/internal/payouts/stripe-account-events` is
 *     the down-projected `account.updated` ingest from service-webhook
 *     (TS-090); pinned to `STRIPE_EVENTS_API_KEY` via the
 *     `STRIPE_EVENTS_HEADER_NAME` header rather than `AccessTokenGuard`
 *     so the `TenantContextInterceptor` cannot seed a scoped frame.
 *
 *   - `TransferEventsController.ingest` —
 *     `internal-payout-transfer-event` reason.
 *     `POST /api/v1/internal/payouts/transfer-events` is the down-
 *     projected `transfer.paid` / `transfer.failed` ingest from
 *     service-webhook (TS-091); pinned to `PAYOUT_TRANSFERS_API_KEY`
 *     via the `PAYOUT_TRANSFERS_HEADER_NAME` header. Same shared-secret
 *     pin as the stripe-events ingest; identical wrap rationale.
 *
 * The remaining controllers — `ConnectController` (provider self-
 * service + admin), `DisbursementsController` (admin-only sweep +
 * schedule + execute + cancel + list + detail), and
 * `MeDisbursementsController` (provider self-service history) — sit
 * behind `AccessTokenGuard`, so the `TenantContextInterceptor` seeds a
 * scoped frame from the access-token claims before the handler body
 * runs. `HealthController.readiness` is exempt by construction —
 * `prisma.ping()` routes to the BASE PrismaClient (member of the
 * `BASE_CLIENT_PASSTHROUGH` set in `wrapWithTenantScope`), not the
 * extended client, so the gate is never consulted.
 *
 * `unscopedModels` is empty. None of the payouts models is a platform-
 * wide catalog with anonymous read access; every model
 * (`ProviderPayoutAccount`, `PayoutAccountLinkEvent`,
 * `StripeAccountEvent`, `PayoutDisbursement`) is per-provider /
 * per-disbursement. Admin reads seed a scoped frame from the access-
 * token claims; internal shared-secret endpoints wrap in
 * `runWithoutTenantContext` explicitly.
 *
 * Env wiring. `NestAuthModule.forRoot` + `TenantContextModule.forRoot`
 * need configuration synchronously at module-definition time. We call
 * `loadEnv()` here once — it's pure zod validation, idempotent against
 * the same `process.env`, and matches the pattern in `main.ts`. The
 * result is still re-validated by `AppConfigModule`'s factory provider
 * so downstream modules continue to consume `ENV_TOKEN` via DI. Mirrors
 * the service-notification / service-audit / service-accounting pattern.
 *
 * Deferred (Phase 1 + TS-090 / TS-091 follow-ups):
 *   - Live Stripe SDK wiring (TS-090-followup-1; TS-091-followup-1).
 *   - Live HTTP balance read against service-accounting
 *     (TS-091-followup-2 — Phase 1 uses the stub PayableBalanceProvider).
 *   - Accounting postback on disbursement success: DR Provider Payable /
 *     CR Cash + balance decrement (TS-091-followup-3 / TS-083-followup-9).
 *   - 1099-NEC annual generation (TS-091-followup-7).
 *   - Domain events via outbox (TS-090-followup-3 / TS-091-followup-4,
 *     lands with TS-142).
 *   - OpenTelemetry tracing + Prometheus metrics (TS-090-followup-4 /
 *     TS-091-followup-8).
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-payouts:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-payouts' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-payouts',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // No platform-wide catalog tables in this service — every model
      // (`ProviderPayoutAccount`, `PayoutAccountLinkEvent`,
      // `StripeAccountEvent`, `PayoutDisbursement`) is per-provider /
      // per-disbursement. Admin reads seed a scoped frame from the
      // access-token claims; internal shared-secret endpoints wrap in
      // `runWithoutTenantContext` explicitly.
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
    ConnectModule,
    DisbursementsModule,
  ],
})
export class AppModule {}
