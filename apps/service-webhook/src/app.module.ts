import { Module } from '@nestjs/common';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { CheckrWebhookModule } from './modules/checkr/checkr.module';
import { StripeWebhookModule } from './modules/stripe/stripe.module';
import { WebhookMetricsModule } from './observability/webhook-metrics.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Webhook service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-041a skeleton.
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
 *   - `ObservabilityModule.forRoot` — TS-041a-followup-4 /
 *     TS-022-followup-3a-followup-1. The shared
 *     `@taste-and-see/nest-observability` package wires the Prometheus
 *     `/metrics` scrape endpoint + the global HTTP-metrics interceptor
 *     (the OTel SDK init runs earlier via `main.ts`'s first-line bootstrap
 *     import). The domain `WebhookMetrics` counters both webhook
 *     controllers inject stay service-local in `WebhookMetricsModule`
 *     (`@Global`) — domain metrics are not boilerplate.
 *   - `OutboxModule.forRoot` (global) — TS-142-followup-1 PRODUCER-side
 *     outbox SDK. Wires `OutboxService` so webhook-side producers append
 *     platform domain events transactionally with their ingress-table
 *     write once the synchronous dispatch hops migrate onto the relay.
 *     The `webhook.outbox_events` table + SDK ship ahead of those
 *     producers so this migration review stays decoupled.
 *   - `StripeWebhookModule` — TS-041a Stripe signature-verified ingress.
 *   - `CheckrWebhookModule` — TS-051 Checkr signature-verified ingress.
 *
 * Future inbound integrations slot in under `src/modules/` per the
 * standard layout in PDD §7.1:
 *   - `twilio` — TS-073 follow-up (Twilio delivery receipts).
 *   - `apple-pay` / `google-pay` — if/when alternate payment rails join
 *     the platform.
 *
 * Each inbound integration owns: (1) its own signature verifier service;
 * (2) its own `*_processed_events` table; (3) its own controller route
 * (`/api/v1/webhooks/{provider}`). The composition root remains a flat
 * list of modules; no cross-talk between providers.
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
 * service-webhook is structurally different from every other rollout
 * target: there is NO `AccessTokenGuard` anywhere in this service. The
 * single auth model on every inbound surface is signature verification
 * (CLAUDE.md §3.5 / §17.8) — Stripe's `Stripe-Signature` HMAC, Checkr's
 * `X-Checkr-Signature` HMAC, and (later) Twilio's signed-request header.
 * The third-party edge does not log in as a Taste & See user; there is
 * no `request.requestContext` to seed. The `TenantContextInterceptor`
 * therefore never produces a scoped frame on this service's request
 * path, and every Prisma-touching handler MUST wrap its body in
 * `runWithoutTenantContext(this.tenantStore, '<reason>', ...)`.
 *
 * Pre-auth + internal exempt surfaces in service-webhook (every inbound
 * handler is wrapped because there is no authenticated surface):
 *
 *   - `StripeWebhookController.receive`
 *     (TS-020-followup-2b-platform-rollout) — `external-stripe-webhook-receive`
 *     reason. `POST /api/v1/webhooks/stripe` is Stripe's edge POSTing
 *     events; the `Stripe-Signature` HMAC is the auth model.
 *
 *   - `CheckrWebhookController.receive`
 *     (TS-020-followup-2b-platform-rollout) — `external-checkr-webhook-receive`
 *     reason. `POST /api/v1/webhooks/checkr` is Checkr's edge POSTing
 *     events; the `X-Checkr-Signature` HMAC is the auth model.
 *
 * `HealthController.readiness` is exempt by construction — `prisma.ping()`
 * routes to the BASE PrismaClient, not the extended client, so the gate
 * is never consulted (see `wrapWithTenantScope`'s
 * `BASE_CLIENT_PASSTHROUGH` set).
 *
 * Future inbound integrations (Twilio, Apple/Google Pay, etc.) MUST wrap
 * their handler body in `runWithoutTenantContext(this.tenantStore,
 * '<reason>', ...)` with a unique grep-able reason string — captured
 * here so the convention has a named home.
 *
 * `unscopedModels` is empty: `StripeProcessedEvent`,
 * `CheckrProcessedEvent`, and `OutboxEvent` (the TS-142-followup-1
 * producer table) are append-only event mirrors with no Taste & See
 * tenant axis, but they sit entirely behind the exempt wraps documented
 * above — every write happens inside an `external-*-webhook-receive`
 * frame. (The `@taste-and-see/nest-outbox` SDK writes `OutboxEvent` rows
 * via raw SQL inside the caller's `$transaction`, so the gate's
 * model-level check never intercepts them regardless — same posture as
 * service-identity / service-household / service-provider /
 * service-accounting.) Marking any of them unscoped would weaken the
 * gate's "every model is either tenant-bound or explicitly platform-wide
 * catalog" invariant without buying any operational benefit. Future
 * audit needs can grep for the `external-*-webhook-receive` reason
 * strings to surface every "no-context" Prisma access from this service.
 *
 * Env wiring. `AppModule` does not consume the validated `Env` itself;
 * `AppConfigModule` resolves it for downstream modules. `loadEnv()` is
 * called once here for the `TenantContextModule.forRoot({ environment:
 * moduleEnv.NODE_ENV, ... })` factory argument — the dynamic module's
 * shape depends on the resolved options. Matches the pattern used in
 * `service-booking` / `service-subscription` / `service-provider`.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-webhook',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Empty: every Prisma-touching handler wraps in
      // `runWithoutTenantContext('external-*-webhook-receive', ...)`,
      // so the gate sees an explicit exempt frame on every operation.
      // The two row types (`StripeProcessedEvent`, `CheckrProcessedEvent`)
      // are not platform-wide catalog tables; they're append-only
      // third-party event mirrors that only the exempt-wrapped inbound
      // handlers ever touch.
      unscopedModels: [],
    }),
    ObservabilityModule.forRoot({ serviceName: 'service-webhook' }),
    // TS-142-followup-1 — PRODUCER-side outbox SDK. Wires `OutboxService`
    // so webhook-side producers can append platform domain events
    // transactionally with the ingress-table write once the per-source
    // synchronous dispatch hops migrate onto the relay (TS-026-followup-1
    // KYC, TS-051-followup-1 background-check, TS-073-followup-5 delivery
    // receipts). `schemaName` matches the Postgres schema that owns the
    // `outbox_events` table created in the 20260608120000_outbox_events
    // migration; the relay polls `webhook.outbox_events` by exact-match
    // against this name. The table + SDK ship ahead of the per-event
    // producer follow-ups so the migration review stays decoupled. The
    // SDK writes via raw SQL inside the caller's `$transaction`, so the
    // TenantContext gate's model-level check never intercepts it —
    // `OutboxEvent` deliberately stays out of `unscopedModels` (mirrors
    // service-identity / service-household / service-provider /
    // service-accounting's wiring; and in this service every write
    // already happens inside an `external-*-webhook-receive` exempt
    // frame regardless).
    OutboxModule.forRoot({
      serviceName: 'service-webhook',
      schemaName: 'webhook',
    }),
    WebhookMetricsModule,
    PrismaModule,
    HealthModule,
    StripeWebhookModule,
    CheckrWebhookModule,
  ],
})
export class AppModule {}
