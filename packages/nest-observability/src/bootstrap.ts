/**
 * OpenTelemetry tracing + Prometheus metrics bootstrap helper
 * (TS-022-followup-3a-followup-1).
 *
 * `createObservabilityBootstrap()` MUST run before any instrumented module
 * is loaded — `@opentelemetry/auto-instrumentations-node` patches `http`,
 * `pg`, `ioredis`, `@nestjs/core`, etc. at module-load time via
 * require-in-the-middle, and that hook only patches modules required AFTER
 * `initTracing()` runs. So the canonical wiring is a per-service
 * `src/observability/bootstrap.ts` shim:
 *
 *     import { createObservabilityBootstrap } from '@taste-and-see/nest-observability/bootstrap';
 *     createObservabilityBootstrap('service-foo');
 *
 * imported as the VERY FIRST line of `main.ts`. The shim's `require`
 * resolves + evaluates this file (which transitively requires only
 * `@taste-and-see/tracing` — never `@nestjs/core`) and runs the inits,
 * all before `main.ts`'s later imports (`@nestjs/core`, the AppModule,
 * the instrumented db/cache clients) evaluate.
 *
 * **Why this lives behind the `/bootstrap` subpath and NOT the package
 * barrel:** the barrel re-exports `ObservabilityModule`, which imports
 * `@nestjs/core`. Importing the barrel to reach this helper would pull
 * `@nestjs/core` into the require graph BEFORE `initTracing()` runs,
 * losing the Nest auto-instrumentation — the exact failure mode this
 * first-line bootstrap exists to prevent. Keep the import path
 * `@taste-and-see/nest-observability/bootstrap`, not the barrel.
 *
 * The helper reads the `OTEL_TRACES_ENABLED` / `OTEL_METRICS_ENABLED` /
 * `OTEL_EXPORTER_OTLP_ENDPOINT` env vars directly from `process.env` (NOT
 * through a service's `loadEnv()`) — Zod validation runs further down the
 * boot path; gating the OTel SDK on it would require importing the config
 * module before this bootstrap, defeating the purpose. Each service's env
 * schema re-declares the same three knobs so a configured pod still
 * validates.
 *
 * Defaults match the env schema for safety in case the env is missing:
 *   - traces ON
 *   - metrics ON
 *   - version from `SERVICE_VERSION` env, falling back to `dev`
 *   - env label from `NODE_ENV`, falling back to `development`
 *
 * See PDD §20.5 + CLAUDE.md §10 for the observability contract.
 */

import { type SentryBootstrapResult, initSentry } from '@taste-and-see/sentry/node';
import { initMetrics, initTracing } from '@taste-and-see/tracing';

/** Resolved observability flags, returned so `main.ts` can log them. */
export interface ObservabilityBootstrapResult {
  /** Resolved `OTEL_TRACES_ENABLED` (default `true`). */
  readonly tracesEnabled: boolean;
  /** Resolved `OTEL_METRICS_ENABLED` (default `true`). */
  readonly metricsEnabled: boolean;
  /** Resolved deployment-environment label (`NODE_ENV`, default `development`). */
  readonly env: string;
  /** Resolved service version (`SERVICE_VERSION`, default `dev`). */
  readonly version: string;
  /**
   * Whether Sentry error reporting came up, and if not, why (TS-504-followup-2a).
   *
   * Also readable later via `getSentryStatus()` — `ObservabilityModule` logs it
   * once the service logger exists, because this return value is discarded by
   * every caller today.
   */
  readonly sentry: SentryBootstrapResult;
}

/**
 * Parse a boolean env flag, accepting `true`/`1`/`false`/`0`
 * (case-insensitive). An unset, empty, or unrecognised value falls back to
 * `fallback` — mirroring the per-service env-schema coercion so the SDK
 * default never diverges from what `loadEnv()` would have resolved.
 */
function readFlag(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const v = raw.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

/**
 * Initialise the platform OpenTelemetry tracing + Prometheus metrics SDKs
 * for `serviceName`. Idempotency + double-init protection live in
 * `@taste-and-see/tracing`'s `initTracing` / `initMetrics`; this helper is
 * a thin, env-reading facade over them so every service's first-line
 * bootstrap is a single call.
 */
export function createObservabilityBootstrap(serviceName: string): ObservabilityBootstrapResult {
  if (typeof serviceName !== 'string' || serviceName.length === 0) {
    throw new Error('createObservabilityBootstrap: serviceName must be a non-empty string');
  }

  const tracesEnabled = readFlag('OTEL_TRACES_ENABLED', true);
  const metricsEnabled = readFlag('OTEL_METRICS_ENABLED', true);
  const env = process.env['NODE_ENV'] ?? 'development';
  const version = process.env['SERVICE_VERSION'] ?? 'dev';
  const otlpEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

  initTracing({
    service: serviceName,
    env,
    version,
    enabled: tracesEnabled,
    ...(otlpEndpoint !== undefined && otlpEndpoint.length > 0 ? { endpoint: otlpEndpoint } : {}),
  });

  initMetrics({
    service: serviceName,
    env,
    version,
    enabled: metricsEnabled,
  });

  // Sentry LAST, and deliberately so. It is initialised in errors-only mode
  // (`skipOpenTelemetrySetup`, no instrumentation integrations), but ordering
  // it after `initTracing` means that even if a future SDK upgrade started
  // installing instrumentation, OTel would already own the module patches.
  //
  // Verified empirically when this landed, both directions: loading
  // `@sentry/node` ahead of `initTracing` does NOT cost the fleet its `http`
  // auto-instrumentation (require-in-the-middle patches through
  // `Module._load`, so an already-cached `http` is still wrapped), and
  // `initSentry` leaves OTel's `http.get` wrapper untouched.
  //
  // No env flag of its own: an absent `SENTRY_DSN` is already the off switch,
  // and a second knob that can contradict the first is how a service ends up
  // configured-but-silent.
  const sentry = initSentry({ service: serviceName, env, version });

  return { tracesEnabled, metricsEnabled, env, version, sentry };
}
