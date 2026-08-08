import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { AuditModule } from '@taste-and-see/nest-audit';
import { BullMqSchedulerModule } from '@taste-and-see/nest-bullmq-scheduler';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { OutboxConsumerModule } from '@taste-and-see/nest-outbox-consumer';
import { PagerDutyModule } from '@taste-and-see/nest-pagerduty';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { IncidentsModule } from './modules/incidents/incidents.module';
import { MandatedReporterModule } from './modules/mandated-reporter/mandated-reporter.module';
import {
  OutboxConsumersModule,
  outboxConsumerDedupStoreFactory,
  outboxConsumerRedisFactory,
} from './modules/outbox-consumers/outbox-consumers.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Trust & Safety service composition root (TS-300 skeleton).
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — the skeleton
 *     scaffold (zod-validated env, tenant-scoped Prisma client, `/healthz`
 *     + `/readyz`).
 *   - `TenantContextModule` (global, TS-141) — wires the tenant-scoping SDK
 *     into the service so every DI-resolved Prisma operation flows through
 *     the gate.
 *   - `OutboxModule` — the transactional producer SDK. Included in the
 *     skeleton (structural, no env cluster) because this service is the
 *     designated publisher of `welfare.flagged` (PDD §7.4 event catalog);
 *     the first producer lands with TS-302 and appends INSIDE the same
 *     `$transaction` as the incident state change (PDD §7.3 / CLAUDE.md §5.3).
 *   - `IncidentsModule` — the incident seam (create/get with SLA
 *     computation at insert) PLUS, since TS-301a, the first authenticated
 *     HTTP surface: `POST /api/v1/trust-safety/incidents` (the family/senior
 *     "Report a concern" intake). The insert now emits
 *     `trust_safety.incident.created` inside the same transaction (§5.3).
 *   - `NestAuthModule` (global, TS-301a) — wires the shared
 *     `AccessTokenGuard` from the env-sourced JWT secret / issuer /
 *     audience, mirroring the service-concierge (TS-222) shape.
 *   - `IdempotencyModule` (global, TS-301a) — Redis-backed Idempotency-Key
 *     cache covering every controller method flagged with `@Idempotent()`.
 *   - `MandatedReporterModule` (TS-303a) — the statutory pathway for
 *     suspected elder abuse. Durable half + domain rules only; no
 *     controllers yet. Exports `MandatedReporterService` so the
 *     incident-resolution path can call `assertIncidentResolvable`, the
 *     never-auto-close gate CLAUDE.md §12 requires.
 *
 * `TenantContextModule` enforcement: `enforce` (CLAUDE.md §3.2 + §17.10) —
 * a greenfield service starts in enforce mode; there is no legacy code path
 * to break in. Every Prisma operation requires either an authenticated
 * `RequestContext` frame (seeded by `TenantContextInterceptor` from
 * `request.requestContext`, populated by `AccessTokenGuard` once TS-301
 * lands) or an explicit `runWithoutTenantContext('<reason>', ...)` exempt
 * frame. Any unscoped query is a hard `MissingRequestContextError`, not a
 * log line.
 *
 * `unscopedModels: []` — deliberately empty. `Incident` rows carry
 * household / senior / provider subject ids and are genuinely tenant-scoped
 * data (CLAUDE.md §3.2 row-level checks; unlike service-content's
 * platform-catalog models there is no systemwide-inventory argument here).
 * `OutboxEvent` needs no entry: the outbox SDK appends via raw SQL inside
 * the producer's transaction, which runs under the caller's frame (or an
 * explicit exempt frame in workers) — the same posture as every other
 * producer service.
 *
 * `HealthController` routes `prisma.ping()` to the BASE PrismaClient via
 * `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set, so the gate is
 * never consulted on the health endpoints. When the first
 * non-`AccessTokenGuard` entrypoint lands (an event consumer in TS-302),
 * it MUST wrap its handler body in `runWithoutTenantContext(this.tenantStore,
 * '<unique grep-able reason>', ...)` — the service-content
 * `content-public-blog-read` convention.
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
    AuditModule.forRoot({ producerService: 'service-trust-safety' }),
    // TS-306-followup-1a — the in-service BullMQ sweep scheduler. Owns
    // the REDIS_URL decomposition, the CLAUDE.md §3.7 key prefix
    // (`{env}:service-trust-safety:queue`) and the shutdown drain for the
    // SLA-breach sweep, this service's first queue. `@Global()`, so
    // `IncidentsModule` does not import it.
    BullMqSchedulerModule.forRoot({
      serviceName: 'service-trust-safety',
      environment: moduleEnv.NODE_ENV,
      redisUrl: moduleEnv.REDIS_URL,
    }),
    AppConfigModule,
    // TS-306-followup-1c — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor`
    // (meter `service-trust-safety:http`). The tracing/metrics SDK init
    // happens earlier, in `src/observability/bootstrap.ts` (first import in
    // `main.ts`); by the time Nest builds this graph the global
    // MeterProvider is already wired, which is what makes the domain
    // instruments (`IncidentsMetrics`, `IncidentPagerMetrics`,
    // `SlaBreachMetrics`) report rather than silently no-op.
    ObservabilityModule.forRoot({ serviceName: 'service-trust-safety' }),
    TenantContextModule.forRoot({
      serviceName: 'service-trust-safety',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // `MandatedReporterJurisdiction` (TS-303a) is the schema's ONLY
      // platform-wide model: a per-state reporting-law reference kit, keyed
      // by USPS code, with no household / senior / provider dimension. It is
      // read while opening a case for any tenant, so requiring a tenant frame
      // for it would be scoping a lookup table by an axis it does not have.
      // Everything else here — `Incident`, `MandatedReporterCase` — carries
      // subject ids and stays scoped. See the class doc-block.
      unscopedModels: ['MandatedReporterJurisdiction'],
    }),
    OutboxModule.forRoot({
      serviceName: 'service-trust-safety',
      schemaName: 'trust_safety',
    }),
    // TS-302a — the consumer half. `consumerGroup` is the service name by
    // convention (it is the Redis Streams group identity, and the dedup
    // table's PK is keyed on it, so changing it later orphans every dedup
    // row and re-delivers history).
    OutboxConsumerModule.forRoot({
      consumerGroup: 'service-trust-safety',
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
      serviceName: 'service-trust-safety',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-306 — on-call paging for `critical` incidents, via the shared client
    // extracted in TS-302b. `source` is required by the package and defaults
    // to this service's name in env, so a trust & safety page is never
    // mistaken for a concierge one in the responder's timeline.
    PagerDutyModule.forRoot({
      source: moduleEnv.PAGERDUTY_SOURCE,
      routingKey: moduleEnv.PAGERDUTY_ROUTING_KEY,
      eventsUrl: moduleEnv.PAGERDUTY_EVENTS_URL,
      timeoutMs: moduleEnv.PAGERDUTY_TIMEOUT_MS,
    }),
    PrismaModule,
    HealthModule,
    IncidentsModule,
    MandatedReporterModule,
    OutboxConsumersModule,
  ],
})
export class AppModule {}
