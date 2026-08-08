/**
 * Sentry Node bootstrap for Taste & See services (CLAUDE.md §10: "Errors:
 * Sentry with release tagging").
 *
 * ## Errors only — this SDK does not own traces
 *
 * `@sentry/node` v8+ is built on OpenTelemetry: a default `Sentry.init()`
 * stands up its own `NodeSDK`, its own propagator, and a full set of
 * instrumentation integrations that patch `http`, `express`, `pg`, `ioredis`
 * and Prisma via require-in-the-middle. This platform already runs exactly
 * that stack from `@taste-and-see/tracing` (`initTracing`), wired into all 21
 * Nest workloads under TS-306-followup-1d.
 *
 * Two OTel SDKs racing to patch the same modules is not a merge — it is
 * double spans, a contested context manager, and a propagator that may or may
 * not be the one the rest of the fleet agrees on. So Sentry is initialised in
 * a deliberately narrow mode:
 *
 *   - `skipOpenTelemetrySetup: true` — do not install a provider.
 *   - `defaultIntegrations: false` + an explicit list — no instrumentation
 *     integrations at all.
 *   - no `tracesSampleRate` — performance data comes from the OTLP collector.
 *
 * The two systems are joined instead by a tag: `initSentry` registers an
 * event processor that copies the **active OpenTelemetry trace id** onto every
 * event, so an error in Sentry names the trace to open in the collector. That
 * is the integration point, and it costs nothing.
 *
 * ## Why the integration list is what it is
 *
 * Included, all of them non-instrumenting:
 *   `onUncaughtException` / `onUnhandledRejection` — the reason this package
 *   exists. Nest's `RfcProblemFilter` catches everything inside a request;
 *   these two catch what happens outside one (a BullMQ processor, an outbox
 *   consumer tick, a floating promise).
 *   `linkedErrors` — follows `cause` chains, which this codebase produces by
 *   the handful wrapping downstream failures.
 *   `dedupe`, `eventFilters`, `functionToString`, `nodeContext`, `modules`,
 *   `contextLines` — noise control and debugging context, no payload access.
 *
 * Excluded on purpose, beyond the instrumentation set:
 *   `localVariables` — attaches the local variables of the throwing frame.
 *   In a login handler that is the plaintext password; in a payment handler
 *   it is whatever came off the Stripe payload. `scrubSentryEvent` would
 *   censor the well-named ones, but a variable called `p` is not well named,
 *   and §17.2 is not a best-effort rule. Do not enable it.
 *   `requestData` — a PII surface that, with no HTTP integration to feed it,
 *   would collect nothing anyway.
 *   `console` / `captureConsole` — this platform logs through pino, whose
 *   redaction happens at the logger layer (§10). Mirroring stray `console.*`
 *   calls into breadcrumbs adds an unredacted channel and no signal.
 */

import { trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';

import { scrubBreadcrumb, scrubSentryEvent } from './scrub';

export interface InitSentryOptions {
  /** Bounded-context service name — becomes the `service` tag and the release prefix. Required. */
  service: string;
  /** DSN. Defaults to `SENTRY_DSN`. Absent ⇒ Sentry stays off and says so. */
  dsn?: string;
  /** Deployment environment label. Defaults to `NODE_ENV` then `development`. */
  env?: string;
  /** Build / image version. Defaults to `SERVICE_VERSION` then `dev`. */
  version?: string;
  /** Set `false` to no-op (tests, CLI scripts). Defaults to `true`. */
  enabled?: boolean;
}

/**
 * Why Sentry is or is not reporting. Returned rather than swallowed so
 * `main.ts` can log it on the startup line.
 *
 * An unconfigured error tracker looks exactly like a healthy one from the
 * inside — the same failure mode as TS-306-followup-1c's no-op meter and
 * TS-306-followup-1d's instrument-without-a-bootstrap. The caller is expected
 * to log `no_dsn` at WARN outside development, because in production that
 * state *is* the outage.
 */
export type SentryBootstrapResult =
  | { readonly enabled: true; readonly release: string }
  | { readonly enabled: false; readonly reason: 'no_dsn' | 'disabled' };

let initialised = false;
let lastResult: SentryBootstrapResult | undefined;

/**
 * The outcome of the last `initSentry` call, or `undefined` if it was never
 * called.
 *
 * Exists because the caller that knows the outcome (`main.ts`'s first-line
 * bootstrap) runs before any logger exists, while the place that can report
 * it usefully (Nest's DI graph, where the service logger is live) has no way
 * to ask. Without this, `{ enabled: false, reason: 'no_dsn' }` would be
 * computed correctly and then discarded — the same shape as
 * TS-306-followup-1c's no-op meter, where the instrumentation existed and
 * reported nothing.
 */
export function getSentryStatus(): SentryBootstrapResult | undefined {
  return lastResult;
}

function record(result: SentryBootstrapResult): SentryBootstrapResult {
  lastResult = result;
  return result;
}

/**
 * Initialise Sentry error reporting. Safe to call when unconfigured — it
 * returns `{ enabled: false, reason: 'no_dsn' }` and installs nothing, so a
 * developer running the fleet locally is not required to hold a DSN.
 *
 * Idempotent by short-circuit: a second call returns the first call's outcome
 * shape rather than re-initialising, because unlike `initTracing` a duplicate
 * `Sentry.init` silently replaces the client mid-flight instead of failing.
 */
export function initSentry(options: InitSentryOptions): SentryBootstrapResult {
  if (typeof options.service !== 'string' || options.service.length === 0) {
    throw new Error('initSentry: service must be a non-empty string');
  }
  if (options.enabled === false) return record({ enabled: false, reason: 'disabled' });

  const dsn = options.dsn ?? process.env['SENTRY_DSN'];
  if (dsn === undefined || dsn.length === 0) return record({ enabled: false, reason: 'no_dsn' });

  const env = options.env ?? process.env['NODE_ENV'] ?? 'development';
  const version = options.version ?? process.env['SERVICE_VERSION'] ?? 'dev';
  // `name@version` is Sentry's release convention. The service name is part
  // of it because a fleet of 24 workloads deploys at 24 independent versions;
  // a bare version string would attribute a booking regression to whatever
  // else shipped that tag.
  const release = `${options.service}@${version}`;

  if (initialised) return record({ enabled: true, release });
  initialised = true;

  Sentry.init({
    dsn,
    environment: env,
    release,
    // §3.9 / §17.2. Explicit rather than relying on the default, because the
    // default flipping in a major version would be a silent PII regression.
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    registerEsmLoaderHooks: false,
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.nodeContextIntegration(),
      Sentry.modulesIntegration(),
      Sentry.contextLinesIntegration(),
    ],
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    initialScope: { tags: { service: options.service } },
  });

  // The join between the two telemetry systems. `beforeSend` would work too,
  // but an event processor runs before the scrub and keeps `beforeSend` as
  // the single place redaction happens.
  // `@opentelemetry/api` — the interface-only package — NOT
  // `@taste-and-see/tracing`'s `getActiveSpanContext`, even though that helper
  // does exactly this and owns the platform's OTel version pin.
  //
  // The tracing barrel re-exports `initTracing`, which pulls
  // `@opentelemetry/sdk-node` → the gRPC OTLP exporter → `@grpc/grpc-js` →
  // `zlib`. That is fine in a Nest service and fatal in a Next.js portal:
  // webpack cannot bundle it and the build fails outright. Caught by building
  // web-family, not by any type-check. The version here is pinned to the same
  // 1.9.0 the tracing package uses.
  //
  // The empty-string guard is the part `getActiveSpanContext` was doing for
  // us: a non-recording span reports an all-zero context, and tagging an event
  // with a trace id that resolves to nothing in the collector is worse than
  // leaving it untagged.
  Sentry.getGlobalScope().addEventProcessor((event) => {
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext !== undefined && spanContext.traceId !== '') {
      event.tags = { ...event.tags, otel_trace_id: spanContext.traceId };
    }
    return event;
  });

  return record({ enabled: true, release });
}

/**
 * Flush buffered events and close the client. Call from the same SIGTERM /
 * SIGINT handler that runs `shutdownTracing` / `shutdownMetrics` — the errors
 * worth having are disproportionately the ones thrown on the way down, and an
 * unflushed client drops them.
 *
 * `timeoutMs` bounds the wait so a Sentry outage cannot hold a pod in
 * terminating until the kubelet SIGKILLs it.
 */
export async function shutdownSentry(timeoutMs = 2_000): Promise<void> {
  if (!initialised) return;
  initialised = false;
  await Sentry.close(timeoutMs);
}

/**
 * Report an error. A no-op when Sentry was never initialised, so call sites
 * (notably `RfcProblemFilter`) need no configuration check of their own.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!initialised) return;
  // `context` rides in `extra`, which `scrubSentryEvent` walks with the same
  // rules as everything else — a caller cannot opt out of redaction by
  // choosing this parameter.
  Sentry.captureException(error, context === undefined ? undefined : { extra: context });
}

/** Test seam: forget that `init` ran. Not exported from the package barrel. */
export function __resetSentryForTests(): void {
  initialised = false;
  lastResult = undefined;
}
