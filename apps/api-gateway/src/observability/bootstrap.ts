/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap for api-gateway
 * (TS-306-followup-1d).
 *
 * Imported as the VERY FIRST line of `main.ts` — `createObservabilityBootstrap`
 * runs `initTracing` / `initMetrics` as a module-load side effect, before any
 * instrumented module (`@nestjs/core`, `pg`, `ioredis`, ...) is required, so
 * `@opentelemetry/auto-instrumentations-node` patches them. Keep `main.ts`'s
 * top-of-file import order intact.
 *
 * **This service is the TRACE ROOT for the entire platform**, which makes its
 * absence the most consequential of the twelve. Every request enters here and
 * fans out over `DownstreamHttpClient`; with no SDK init the outbound `http`
 * spans were never created, so no cross-service trace had a parent and the
 * per-hop context the gateway already propagates (TS-140's signed
 * internal-trust headers) had nothing to attach to. Wiring this is what turns
 * every downstream service's existing spans into one trace.
 *
 * The domain counters for the auth proxies (`auth_proxy_login_outcome_total`
 * and friends) are TS-140-followup-4 and are deliberately NOT invented here —
 * this lands the plumbing they need.
 *
 * The shared helper is imported via the
 * `@taste-and-see/nest-observability/bootstrap` subpath (NOT the package
 * barrel) precisely so this require graph never pulls in `@nestjs/core` ahead
 * of the OTel init. See the package's `src/bootstrap.ts`.
 *
 * The `/metrics` scrape route + the global `HttpMetricsInterceptor` come from
 * `ObservabilityModule.forRoot` in `app.module.ts`. Domain counters are NOT
 * added here — TS-306-followup-1d wires the plumbing; an instrument a surface
 * has not earned is noise, and one written against an uninitialised provider
 * is worse (the service-content finding in TS-306-followup-1c).
 * See PDD §20.5 + CLAUDE.md §10 for the observability contract.
 */
import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';

createObservabilityBootstrap('api-gateway');
