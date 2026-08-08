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
import { ArticlesModule } from './modules/articles/articles.module';
import { AuthorsModule } from './modules/authors/authors.module';
import { FeedbackModule } from './modules/feedback/feedback.module';
import { HelpCategoriesModule } from './modules/help-categories/help-categories.module';
import { PagesModule } from './modules/pages/pages.module';
import { PublicBlogModule } from './modules/public-blog/public-blog.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Content & CMS service composition root (TS-280 skeleton).
 *
 * Modules registered here:
 *   - `AppConfigModule` / `PrismaModule` / `HealthModule` — the skeleton
 *     scaffold (zod-validated env, tenant-scoped Prisma client, `/healthz`
 *     + `/readyz`).
 *   - `TenantContextModule` (global, TS-141) — wires the tenant-scoping SDK
 *     into the service so every DI-resolved Prisma operation flows through
 *     the gate.
 *
 * `PagesModule` (TS-284) is the first AUTHENTICATED HTTP surface — the
 * content-admin static-pages CMS (create a page, append append-only
 * `page_versions`, publish a version live). It is what pulls `NestAuthModule`
 * (the shared `AccessTokenGuard` wired from the env-sourced JWT secret / issuer
 * / audience) + `IdempotencyModule` (Redis-backed `@Idempotent()` cache) +
 * `OutboxModule` (the transactional audit-event producer) into the composition
 * root, and the JWT / Redis env clusters arrive with it — mirroring the
 * service-ads (TS-271a) shape. The skeleton (TS-280) carried no dead config
 * until this surface landed (the TS-070 / TS-221 convention). The OTel
 * observability bootstrap is still deferred (a carried followup) — this slice
 * adds the auth/idempotency/outbox clusters only.
 *
 * The remaining authoring surfaces (blog admin TS-281, help center TS-283) land
 * in subsequent TS-28x slices on this same wiring.
 *
 * `TenantContextModule` enforcement: `enforce` (CLAUDE.md §3.2 + §17.10).
 * Every Prisma operation requires either an authenticated `RequestContext`
 * frame (seeded by `TenantContextInterceptor` from `request.requestContext`,
 * populated by `AccessTokenGuard` once it lands in TS-281) or an explicit
 * `runWithoutTenantContext('<reason>', ...)` exempt frame. Any unscoped query
 * is a hard `MissingRequestContextError`, not a log line — the loud-failure
 * posture CLAUDE.md §3.2 + §17.10 demand. The shape mirrors the canonical
 * wiring landed across every other Nest service.
 *
 * `unscopedModels: ['Page', 'PageVersion', 'Article', 'ArticleVersion',
 * 'HelpCategory']`. CMS content (marketing pages, blog articles, help-center
 * categories + their append-only version rows) is SYSTEMWIDE editorial
 * inventory authored by Marketing / Content staff behind `content:write`
 * (PRD §10.10 / §10.11) — it has NO per-household tenant axis, exactly like
 * service-subscription's `Plan` / `Coupon` catalog or service-ads' campaign
 * inventory. So all five models are declared unscoped and the TS-141 gate
 * treats their reads/writes as legitimately tenant-free. Should a genuine
 * partner-tenant content boundary (a partner-authored co-marketing page) ever
 * land, that surface revisits the scoping then — for the Phase-2 admin-managed
 * CMS, all five are platform catalog.
 *
 * `HealthController` routes `prisma.ping()` to the BASE PrismaClient via
 * `wrapWithTenantScope`'s `BASE_CLIENT_PASSTHROUGH` set, so the gate is never
 * consulted on the health endpoints. The first non-`AccessTokenGuard`
 * entrypoint landed with `PublicBlogModule` (TS-282-followup-3): its handlers
 * wrap every read in `runWithoutTenantContext(this.tenantStore,
 * 'content-public-blog-read', ...)` — the unique, grep-able exempt reason this
 * doc-block mandates. Any future anonymous entrypoint follows the same shape
 * with its own reason string so the audit-log scan stays useful.
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
    AuditModule.forRoot({ producerService: 'service-content' }),
    AppConfigModule,
    // TS-306-followup-1c — shared observability wiring: the Prometheus
    // `/metrics` scrape route + the global `HttpMetricsInterceptor` (meter
    // `service-content:http`). The tracing/metrics SDK init happens earlier,
    // in `src/observability/bootstrap.ts` (first import in `main.ts`). This
    // is also what makes `PublicBlogMetrics` (TS-282-followup-3) report at
    // last: it has been calling `getMeter` since the public blog shipped,
    // against a provider that was never initialised.
    ObservabilityModule.forRoot({ serviceName: 'service-content' }),
    TenantContextModule.forRoot({
      serviceName: 'service-content',
      environment: moduleEnv.NODE_ENV,
      enforcement: 'enforce',
      // Every model in the content schema is platform-wide editorial
      // inventory with no per-household tenant axis — declared unscoped like
      // service-subscription's `Plan` / `Coupon` catalog. See the class
      // doc-block for the rationale.
      unscopedModels: [
        'Page',
        'PageVersion',
        'Article',
        'ArticleVersion',
        'HelpCategory',
        'ContentAuthor',
        'ArticleAuthor',
        'ArticleFeedback',
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
      serviceName: 'service-content',
      ttlSeconds: moduleEnv.IDEMPOTENCY_TTL_SECONDS,
      inFlightTtlSeconds: moduleEnv.IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS,
      backend: { kind: 'redis-url', redisUrl: moduleEnv.REDIS_URL },
    }),
    // TS-284 — outbox producer SDK (global). The content-admin mutation service
    // injects `OutboxService` (via `AuditEmitter`) and appends an
    // `audit.action_recorded` row to `content.outbox_events` INSIDE the same
    // `$transaction` as the state change, so the audit record commits atomically
    // with the mutation (PDD §7.3 / CLAUDE.md §5.3, §3.6). The worker-outbox-relay
    // drains the table onto Redis Streams; service-audit's consumer persists
    // append-only + hash-chained.
    OutboxModule.forRoot({ serviceName: 'service-content', schemaName: 'content' }),
    PrismaModule,
    HealthModule,
    PagesModule,
    // TS-284-followup-3 — the blog/help-article authoring surface and the
    // help-center taxonomy surface, mirroring `PagesModule` on the same
    // auth / idempotency / outbox wiring.
    ArticlesModule,
    HelpCategoriesModule,
    // TS-283 — author profiles + multi-author collaboration (byline credits).
    AuthorsModule,
    // TS-287 — end-user "Was this helpful?" feedback + related-article
    // suggestions (the first USER-FACING, non-admin surface on service-content).
    FeedbackModule,
    // TS-282-followup-3 — the PUBLIC (anonymous) blog read projection behind
    // web-marketing /blog. First non-AccessTokenGuard entrypoint; see the
    // tenant-scoping note above (`content-public-blog-read` exempt frames).
    PublicBlogModule,
  ],
})
export class AppModule {}
