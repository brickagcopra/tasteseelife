import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { ThreadsModule } from './modules/threads/threads.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';

/**
 * Messaging service composition root.
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — TS-070
 *     skeleton.
 *   - `RealtimeModule` — TS-071. Socket.IO + Redis-adapter delivery
 *     surface per PDD §13.1. Boots the `@WebSocketGateway` and the
 *     `RealtimeBroadcaster` service; the underlying Redis adapter is
 *     installed at the application level in `main.ts` via
 *     `app.useWebSocketAdapter(...)`.
 *   - `TenantContextModule` (global) — TS-020-followup-2b-platform-rollout.
 *     Wires the TS-141 tenant-scoping SDK into the service so every
 *     DI-resolved Prisma operation flows through the gate.
 *
 * Modules registered here (TS-070-followup-2):
 *   - `ThreadsModule` — the authenticated thread + thread-participant CRUD
 *     surface (`POST /api/v1/threads`, `GET /api/v1/threads/me`, `GET
 *     /api/v1/threads/:threadId`, `POST`/`DELETE` on `…/:threadId/
 *     participants/…`). The first authenticated HTTP write surface, which is
 *     why `NestAuthModule` (AccessTokenGuard) + `IdempotencyModule` register
 *     here and the idempotency env cluster arrives — mirroring the
 *     service-concierge / service-household shape. The row-level trust gate
 *     is the caller's own `thread_participants` row.
 *   - `NestAuthModule` (global) — TS-070-followup-2. Wires the shared
 *     `AccessTokenGuard` from the env-sourced JWT secret / issuer / audience
 *     (the same triple the TS-071 realtime handshake already validates).
 *   - `IdempotencyModule` (global) — TS-070-followup-2. Redis-backed
 *     Idempotency-Key cache covering every controller method flagged with
 *     `@Idempotent()` (thread create / add participant / remove participant).
 *
 * Future modules (captured up-front so the layout is predictable):
 *   - `MessagesModule` — Cassandra-backed message create + paginated
 *     read endpoints. Lands as TS-070-followup-1 alongside the
 *     `cassandra-driver` integration. Will inject `RealtimeBroadcaster`
 *     from `RealtimeModule` to fan out `message.created` events on
 *     write.
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
 * WebSocket scoping discipline. service-messaging is the first downstream
 * rollout with a WebSocket surface (`RealtimeGateway`). The
 * `TenantContextInterceptor` only fires for HTTP requests — see the
 * `context.getType() !== 'http'` short-circuit at the top of
 * `intercept`. WebSocket handlers therefore have to seed the frame
 * themselves. The pattern is:
 *
 *   - At handshake time the gateway verifies the JWT and stores the
 *     resulting `RequestContext` on `socket.data.requestContext`
 *     (same shape `AccessTokenGuard` writes onto `request.requestContext`
 *     for HTTP).
 *   - Each `@SubscribeMessage` handler that touches Prisma wraps its
 *     body in `this.tenantStore.runWith(socket.data.requestContext, ...)`
 *     so the AsyncLocalStorage frame is seeded for the lifetime of the
 *     handler. Today only `thread:join` reads Prisma (via
 *     `ThreadMembershipService`); `thread:leave` is a pure Socket.IO
 *     room-leave with no DB hop, so no wrap is needed. A future
 *     `message:send` handler that touches Prisma must follow the same
 *     pattern. We do NOT use `runWithoutTenantContext` here — the user
 *     IS authenticated, so a `scoped` frame is the right shape; an
 *     `exempt` frame would be misleading in audit logs.
 *
 * HTTP pre-auth + internal exempt surfaces in service-messaging: **none**.
 * The only HTTP surface today is `HealthController` (`/healthz` +
 * `/readyz`). Both are read-only and don't touch the gate —
 * `prisma.ping()` routes to the BASE PrismaClient via
 * `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set. If a future
 * HTTP endpoint lands without `AccessTokenGuard` (e.g. an internal
 * webhook ingest), it MUST wrap its handler body in
 * `runWithoutTenantContext(this.tenantStore, '<reason>', ...)` with a
 * unique, grep-able reason string so the audit-log scan stays useful.
 *
 * `unscopedModels` is the empty list. Both models in this service
 * (`Thread`, `ThreadParticipant`) are per-household / per-thread —
 * there is no platform-wide catalog table here. Every read and write is
 * bound to either a household or a specific thread; the participant-row
 * lookup itself is the row-level membership check.
 *
 * Env wiring. `TenantContextModule.forRoot` needs configuration
 * synchronously at module-definition time. We call `loadEnv()` here
 * once — it's pure zod validation, idempotent against the same
 * `process.env`, and matches the pattern in `main.ts` / every other
 * service's AppModule. The result is still re-validated by
 * `AppConfigModule`'s factory provider so downstream modules continue
 * to consume `ENV_TOKEN` via DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-messaging:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-messaging' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-messaging',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Both models in the messaging schema (`Thread`,
      // `ThreadParticipant`) are per-household / per-thread — there
      // is no platform-wide catalog table. Reads and writes all bind
      // to a thread via the participant-row membership check.
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
      serviceName: 'service-messaging',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    PrismaModule,
    HealthModule,
    RealtimeModule,
    ThreadsModule,
  ],
})
export class AppModule {}
