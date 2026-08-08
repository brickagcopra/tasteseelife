import { Module } from '@nestjs/common';
import { NestAuthModule } from '@taste-and-see/nest-auth';
import { IdempotencyModule } from '@taste-and-see/nest-idempotency';
import { ObservabilityModule } from '@taste-and-see/nest-observability';
import { TenantContextModule } from '@taste-and-see/nest-prisma-tenant-scope';

import { AppConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { HealthModule } from './health/health.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CertificationModule } from './modules/certification/certification.module';
import { CertificationRenewalsModule } from './modules/certification-renewals/certification-renewals.module';
import { QuizModule } from './modules/quiz/quiz.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Cooking Academy service composition root.
 *
 * Modules registered here (TS-250 skeleton):
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — the skeleton.
 *   - `TenantContextModule` (global) — TS-141. Wires the tenant-scoping
 *     SDK into the service so every DI-resolved Prisma operation flows
 *     through the gate.
 *
 * Modules registered here (TS-251):
 *   - `CatalogModule` — the course-catalog admin surface (create / edit /
 *     archive courses; manage the module → lesson hierarchy; manage a
 *     course's cohorts). The first authenticated HTTP surface, gated on
 *     `academy:read` / `academy:write` via `@RequirePermissions(...)` +
 *     `PermissionGuard`.
 *   - `NestAuthModule` (global) — TS-251. Wires the shared `AccessTokenGuard`
 *     from the env-sourced JWT secret / issuer / audience.
 *   - `IdempotencyModule` (global) — TS-251. Redis-backed Idempotency-Key
 *     cache covering every controller method flagged with `@Idempotent()`.
 *
 * Modules registered here (TS-254):
 *   - `QuizModule` — the quiz engine. Admin authoring of a `quiz`-kind lesson's
 *     versioned question bank (`academy:read` / `academy:write`) plus the
 *     student attempt flow (start → randomized N-of-M draw + retake enforcement;
 *     submit → scoring; the pass threshold gates certification, TS-255). The
 *     bank tables are platform-wide catalog (`unscopedModels`); the per-student
 *     attempt tables flow through the gate, filtered by `studentUserId`.
 *
 * Modules registered here (TS-255):
 *   - `CertificationModule` — certification issuance + verification. Admin
 *     issuance / listing / revocation (`academy:read` / `academy:write`) over
 *     the per-student `AcademyCertification` model (gate-scoped; admins act
 *     cross-student), plus the PUBLIC `/verify/cert/:token` page (no auth — the
 *     handler wraps its scoped read in `runWithoutTenantContext`, the first such
 *     exempt surface on service-academy; see the exempt-surface note below).
 *     PDF render is real (`pdfkit`); the S3 store is stub-mode pending
 *     `@aws-sdk` approval (TS-255-followup-2).
 *
 * Modules registered here (TS-256):
 *   - `CertificationRenewalsModule` — the internal certification-renewal
 *     surface the renewal-reminder worker consumes (PRD §9.3; PDD §15.2).
 *     A shared-secret-pinned read of the at-risk certifications batch + the
 *     idempotent lapse `expire` write. No browser-facing surface; the worker
 *     is the sole caller. Touches the scoped `AcademyCertification` model
 *     without `AccessTokenGuard`, so both handlers wrap their bodies in
 *     `runWithoutTenantContext` (see the exempt-surface list below).
 *
 * Forthcoming (captured so the layout is predictable):
 *   - TS-252 lesson player + per-lesson progress, TS-253 cohort sessions.
 *
 * `TenantContextModule` (global, TS-141). Wires a request-scoped
 * `AsyncLocalStorage` store, an interceptor that seeds the store from
 * `request.requestContext` (populated by `AccessTokenGuard` once it lands
 * in TS-251), and the tokens the Prisma extension consumes when
 * `PrismaModule`'s factory wraps `PrismaService` with the gate
 * (`wrapWithTenantScope`).
 *
 * Enforcement: `enforce` (TS-141). Every Prisma operation requires either
 * an authenticated `RequestContext` frame (seeded by
 * `TenantContextInterceptor` from `request.requestContext`) or an explicit
 * `runWithoutTenantContext('<reason>', ...)` exempt frame. Any unscoped
 * query against a scoped model is a hard `MissingRequestContextError`, not
 * a log line — the loud-failure posture CLAUDE.md §3.2 + §17.10 demand. The
 * shape mirrors the canonical wiring landed across service-identity /
 * service-household / service-subscription / service-concierge; each
 * service is a one-PR mechanical mirror.
 *
 * Pre-auth + internal exempt surfaces in service-academy:
 *   - `HealthController` (`/healthz` + `/readyz`) — exempt by construction:
 *     `prisma.ping()` routes to the BASE PrismaClient via
 *     `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set, so the gate is
 *     never consulted.
 *   - `CertificationVerifyController` (`GET /verify/cert/:token`, TS-255) — the
 *     PUBLIC certificate-verification page. Anonymous (no `AccessTokenGuard`)
 *     but reads the SCOPED `AcademyCertification` model, so the handler wraps
 *     its read in `runWithoutTenantContext(this.tenantStore,
 *     'academy-public-cert-verification', ...)`. The service returns only the
 *     PII-minimised public subset.
 *   - `CertificationRenewalsInternalController` (TS-256) — the shared-secret
 *     renewal surface (`GET …/certifications/renewals` +
 *     `POST …/certifications/:id/expire`). Pre-auth (shared-secret header,
 *     not `AccessTokenGuard`) cross-student reads/writes of the scoped
 *     `AcademyCertification` model, so both handlers wrap their bodies in
 *     `runWithoutTenantContext(this.tenantStore,
 *     'academy-internal-certification-renewals' | '…-expire', ...)`.
 * Any future endpoint touching a scoped model without `AccessTokenGuard` MUST
 * wrap its handler body in `runWithoutTenantContext(this.tenantStore,
 * '<reason>', ...)` with a unique, grep-able reason string. (The TS-251 public
 * catalog browse surface, when it lands, reads only `unscopedModels` so it
 * needs no wrap.)
 *
 * `unscopedModels` covers the platform-wide catalog: `AcademyCourse`,
 * `AcademyCourseModule`, `AcademyLesson`, `AcademyCohort` — the same course
 * library every student sees, with no tenant axis (mirrors `Plan` /
 * `Coupon` in service-subscription). The PER-STUDENT tables
 * (`AcademyEnrollment`, `AcademyCertification`) are intentionally NOT in
 * this list — those reads/writes flow through the gate, and row-level
 * filtering by `student_user_id` is the service's responsibility when the
 * enrollment / certification endpoints land (TS-252 / TS-255), the same
 * posture as `Subscription` in service-subscription.
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
    // TS-306-followup-1d — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-academy:http`). The tracing/metrics SDK init happens earlier, in
    // `src/observability/bootstrap.ts` (first import in `main.ts`); by the
    // time Nest builds this graph the global MeterProvider is already wired.
    ObservabilityModule.forRoot({ serviceName: 'service-academy' }),
    AppConfigModule,
    TenantContextModule.forRoot({
      serviceName: 'service-academy',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Platform-wide catalog has no tenant axis. The course → module →
      // lesson hierarchy + cohorts are the same library every student
      // renders on the public catalog; keep them out of the gate so the
      // (forthcoming TS-251) public browse surface works without a
      // per-callsite exempt wrap. Per-student tables (`AcademyEnrollment`,
      // `AcademyCertification`) are intentionally NOT here — those flow
      // through the gate.
      unscopedModels: [
        'AcademyCourse',
        'AcademyCourseModule',
        'AcademyLesson',
        'AcademyCohort',
        // TS-254 quiz bank — platform-wide catalog content (the same questions
        // for every student). The per-student `AcademyQuizAttempt` +
        // `AcademyQuizAttemptAnswer` are intentionally NOT here — they flow
        // through the gate, filtered by `studentUserId` in the service.
        'AcademyQuiz',
        'AcademyQuizQuestion',
        'AcademyQuizQuestionOption',
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
      serviceName: 'service-academy',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    PrismaModule,
    HealthModule,
    CatalogModule,
    QuizModule,
    CertificationModule,
    CertificationRenewalsModule,
  ],
})
export class AppModule {}
