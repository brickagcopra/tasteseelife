import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { BullMqSchedulerModule } from '@taste-and-see/nest-bullmq-scheduler';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { OutboxModule } from '@taste-and-see/nest-outbox';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { AuditModule } from '@taste-and-see/nest-audit';

import { AdminModule } from './modules/admin/admin.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { AuthModule } from './modules/auth/auth.module';
import { KycModule } from './modules/kyc/kyc.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { RecipientContactsModule } from './modules/recipient-contacts/recipient-contacts.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Identity service composition root.
 *
 * Modules added here so far cover the TS-020 skeleton (config,
 * Prisma, health), the TS-021/-022/-023 auth surface (signup, login,
 * MFA), the TS-024 RBAC surface (role assignments + access-token
 * roles claim), the TS-044-followup-2 Idempotency-Key replay
 * cache, the TS-026 KYC surface (Stripe Identity verification
 * sessions + internal webhook-dispatch endpoint), the
 * TS-020-followup-2 tenant-scope SDK (TS-141 Prisma extension), and
 * the TS-142-followup-1 outbox producer SDK (`OutboxModule`, global —
 * appends domain events transactionally with their state change).
 * Future domain modules slot in under `src/modules/` per PDD §7.1.
 *
 * `IdempotencyModule` (global, TS-044-followup-2). Closes
 * TS-021-followup-1. Wraps every controller method flagged with
 * `@Idempotent()` in the Redis-backed Idempotency-Key replay cache
 * from `@taste-and-see/nest-idempotency`. Today only the signup
 * endpoint carries the decorator — the pre-auth surface is where
 * replay safety matters most (a retried POST /signup must NOT
 * silently create a second account or surface a confusing 409 when
 * the original 201 was simply lost on the wire). The package's
 * default actor resolver returns `null` for unauthenticated
 * requests, and the interceptor falls back to the literal `anonymous`
 * for the actor segment of the Redis key — exactly the contract this
 * follow-up calls for. No custom `actorResolver` override is needed
 * because the default already does the right thing AND keeps the
 * door open for future authenticated `@Idempotent()` endpoints
 * (e.g. MFA enrollment confirm, password change) without rewiring
 * the module.
 *
 * `TenantContextModule` (global, TS-020-followup-2). Wires the
 * TS-141 tenant-scoping SDK into the service: a request-scoped
 * `AsyncLocalStorage` store, an interceptor that seeds the store
 * from `request.requestContext` (populated by `AccessTokenGuard`),
 * and the tokens the Prisma extension consumes when `PrismaModule`'s
 * factory wraps `PrismaService` with the gate (`wrapWithTenantScope`).
 *
 * Enforcement: `enforce` (TS-020-followup-2b). Every Prisma operation
 * now requires either an authenticated `RequestContext` frame (seeded
 * by `TenantContextInterceptor` from `request.requestContext`) or an
 * explicit `runWithoutTenantContext('<reason>', ...)` exempt frame.
 * Any unscoped query is a hard `MissingRequestContextError`, not a
 * log line — the loud-failure posture CLAUDE.md §3.2 + §17.10 demand.
 *
 * The ramp from `audit` to `enforce` landed once every pre-auth
 * surface in `service-identity` carried an explicit exempt wrap:
 *
 *   - `AuthController.signup / login / refresh / logout`
 *     (TS-020-followup-2a) — `pre-auth-{name}` reasons.
 *   - `MfaController.verify` (TS-020-followup-2a2) —
 *     `pre-auth-mfa-verify` reason; the user is mid-login with only
 *     a short-lived MFA challenge token, NOT an access token.
 *   - `MfaController.recoveryVerify` (TS-023-followup-2) —
 *     `pre-auth-mfa-recovery-verify` reason; same pre-auth posture as
 *     `verify`, but the user presents a single-use recovery code in
 *     lieu of a TOTP code.
 *   - `KycController.receiveWebhookEvent` (TS-020-followup-2b) —
 *     `internal-kyc-webhook-dispatch` reason; the internal
 *     dispatch surface uses a shared-secret header, not the
 *     AccessTokenGuard.
 *   - `seedRbacCatalog` script (TS-020-followup-2) — `rbac-seed`
 *     reason; runs out of a Nest application context entirely.
 *
 * Every other Prisma-touching surface sits behind `AccessTokenGuard`
 * (the four authenticated MFA endpoints, the two public KYC endpoints,
 * all admin endpoints) so the interceptor seeds a scoped frame from
 * the access-token claims. `HealthController.readiness` is exempt by
 * construction — `prisma.ping()` routes to the BASE PrismaClient, not
 * the extended client, so the gate is never consulted (see
 * `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set).
 *
 * `unscopedModels` covers the RBAC catalog tables (`Permission`,
 * `Role`, `RolePermission`) — these are platform-wide registries
 * with no tenant axis (every service consults the same catalog), so
 * the gate must always let them through regardless of context state.
 * `UserRole` is intentionally NOT in this list: a user's role
 * assignments are tied to a specific user, so reads/writes should
 * still flow through the gate.
 *
 * Env wiring. `IdempotencyModule.forRoot` + `TenantContextModule.forRoot`
 * both need configuration synchronously at module-definition time. We
 * call `loadEnv()` here once — it's pure zod validation, idempotent
 * against the same `process.env`, and matches the pattern in `main.ts` /
 * service-subscription's AppModule / service-household's AppModule.
 * The result is still re-validated by `AppConfigModule`'s factory
 * provider so downstream modules continue to consume `ENV_TOKEN` via
 * DI.
 */
const moduleEnv = loadEnv();

@Module({
  imports: [
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-identity',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Platform-wide RBAC catalog tables have no tenant axis (every
      // service references the same role + permission registry). Keep
      // them out of the gate so admin-side catalog reads + the
      // seedRbacCatalog Job continue to work without a per-callsite
      // exempt wrap. `UserRole` is intentionally NOT in this list
      // — assignments are tied to a specific user, so reads/writes
      // still flow through the gate.
      unscopedModels: ['Permission', 'Role', 'RolePermission'],
    }),
    PrismaModule,
    HealthModule,
    // TS-052-followup-11a — `@taste-and-see/nest-auth` provides
    // `AccessTokenGuard` for the MFA / KYC / admin endpoints. Same
    // env contract the local guard used (TS-022) — only the import
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
      serviceName: 'service-identity',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-142-followup-1 — wires the outbox producer SDK so identity-side
    // producers (e.g. `kyc.status_changed` — TS-026-followup-3 — and the
    // account-locked notification signal — TS-025-followup-3) can append
    // domain events transactionally with their state change. `schemaName`
    // matches the Postgres schema that owns the `outbox_events` table
    // created in the 20260608120000_outbox_events migration; the relay
    // polls `identity.outbox_events` by exact-match against this name.
    // The table + SDK ship ahead of the per-event producer follow-ups so
    // the migration review stays decoupled (one reviewable migration per
    // service). The SDK writes via raw SQL inside the caller's
    // `$transaction`, so the TenantContext gate's model-level check never
    // intercepts it — `OutboxEvent` deliberately stays out of
    // `unscopedModels` (mirrors service-provider's wiring).
    OutboxModule.forRoot({
      serviceName: 'service-identity',
      schemaName: 'identity',
    }),
    // TS-309a — identity becomes the FIFTH consumer of the shared audit
    // emitter extracted in TS-303b-followup-1. `@Global()`, so every module
    // injects `AuditEmitter` without importing anything. TS-309a-followup-3
    // folded the RBAC module's local emitter (TS-295, which predates the
    // package) onto this one, so the service now has exactly one audit path;
    // the RBAC-specific resource map stays local, as the package intends.
    AuditModule.forRoot({ producerService: 'service-identity' }),
    // TS-308a-followup-1 — the in-service BullMQ sweep scheduler, extracted
    // at its third copy. Owns the REDIS_URL decomposition, the CLAUDE.md
    // §3.7 key prefix (`{env}:service-identity:queue`) and the shutdown
    // drain for every repeatable sweep this service runs: the TS-293
    // rbac-revoker and the TS-309a-followup-2 overdue-DSAR sweep. `@Global()`,
    // so neither owning module imports it. Options are validated at
    // module-definition time — a bad REDIS_URL fails the boot rather than
    // the first tick, which would otherwise be silent.
    BullMqSchedulerModule.forRoot({
      serviceName: 'service-identity',
      environment: moduleEnv.NODE_ENV,
      redisUrl: moduleEnv.REDIS_URL,
    }),
    RbacModule,
    AuthModule,
    KycModule,
    RecipientContactsModule,
    AdminModule,
    PrivacyModule,
    ObservabilityModule.forRoot({ serviceName: 'service-identity' }),
  ],
})
export class AppModule {}
