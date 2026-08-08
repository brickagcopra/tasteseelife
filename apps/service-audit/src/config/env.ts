import { z } from 'zod';

/**
 * Environment-variable schema for service-audit.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with TS-100:
 *
 *   - Skeleton — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION`.
 *
 *   - Admin authentication — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *     `JWT_AUDIENCE`. service-audit verifies access tokens minted by
 *     service-identity for the admin read endpoints. Mirrors the
 *     service-booking / service-provider / service-household env
 *     contract.
 *
 *   - Internal-ingest shared secret — `AUDIT_INGEST_HEADER_NAME` /
 *     `AUDIT_INGEST_API_KEY`. Every cross-service caller (e.g.
 *     service-subscription, service-provider) POSTs to
 *     `/api/v1/internal/audit/events` with this header. The TS-151
 *     NetworkPolicy will restrict the route to in-cluster callers; the
 *     header is the application-layer defence-in-depth alongside that
 *     network policy. Mirrors `KYC_WEBHOOK_INTERNAL_API_KEY` /
 *     `BOOKING_TIER_DISPATCH_API_KEY` shape.
 *
 *   - Idempotency cache — `REDIS_URL` + `IDEMPOTENCY_TTL_SECONDS` +
 *     `IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS`. The `@Idempotent()`
 *     interceptor backs the internal ingest endpoint for callers that
 *     prefer the HTTP-level dedup affordance over the `event_id`
 *     unique-constraint dedup.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3016`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking = 3015. The audit service gets the next-available port
     * so the local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3016),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-100 — JWT access-token verification. service-audit consumes
    // JWTs minted by service-identity (TS-022) for the admin read
    // endpoints (`GET /api/v1/admin/audit/events/by-resource` etc.).
    // ───────────────────────────────────────────────────────────────────

    /**
     * HS256 verification secret for access tokens issued by
     * service-identity. Same value as service-identity's
     * `JWT_ACCESS_SECRET` — sharing a symmetric secret across the
     * issuer and verifier is the Phase 1 contract.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /**
     * Pinned issuer claim — must match service-identity's `JWT_ISSUER`.
     */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /**
     * Pinned audience claim — same default as service-identity's
     * `JWT_AUDIENCE`.
     */
    JWT_AUDIENCE: z.string().default('taste-and-see/api'),
    // ───────────────────────────────────────────────────────────────────
    // TS-140-followup-1a — gateway trust-header envelope.
    //
    // The api-gateway verifies the caller's JWT at the edge and does NOT
    // forward it downstream; it mints a signed, time-bounded
    // `x-ts-trust-*` envelope carrying the recovered actor. Without this
    // secret, every route this service exposes through the gateway
    // answers 401 — which is exactly the state the platform was in
    // before TS-140-followup-1a.
    //
    // REQUIRED, deliberately. A missing value does not degrade a
    // feature; it leaves the service reachable only by direct callers,
    // which from the outside reads as "the product is down" while every
    // health check stays green. Failing at boot is the cheaper signal.
    // MUST equal the api-gateway's `INTERNAL_TRUST_SIGNING_SECRET`.
    // ───────────────────────────────────────────────────────────────────
    INTERNAL_TRUST_SIGNING_SECRET: z
      .string()
      .min(
        32,
        'INTERNAL_TRUST_SIGNING_SECRET must be at least 32 characters (HMAC-SHA256 block size)',
      ),
    /**
     * Replay window for a signed envelope, in seconds. Mirror the
     * gateway's `INTERNAL_TRUST_MAX_AGE_SECONDS` — a verifier stricter
     * than the signer rejects legitimate traffic under ordinary clock
     * drift, and a looser one widens the replay window for no gain.
     */
    INTERNAL_TRUST_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(3600).default(60),

    // ───────────────────────────────────────────────────────────────────
    // TS-100 — Internal-ingest shared secret. Every cross-service caller
    // POSTs to `/api/v1/internal/audit/events` with this header. The
    // TS-151 NetworkPolicy restricts the route to in-cluster callers;
    // the header is the application-layer defence-in-depth alongside.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Header carrying the shared secret. Lowercase by convention so the
     * `request.header(...)` call is case-stable. Default mirrors the
     * established `x-internal-api-key` shape.
     */
    AUDIT_INGEST_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    /**
     * Shared-secret value compared against `AUDIT_INGEST_HEADER_NAME`.
     * Must be at least 32 characters; never logged. Rotated via the
     * standard secrets-manager flow (CLAUDE.md §3.5).
     */
    AUDIT_INGEST_API_KEY: z.string().min(32, 'AUDIT_INGEST_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-100 — Idempotency cache (optional surface). The internal ingest
    // endpoint already dedups on `event_id` UNIQUE; the `@Idempotent()`
    // interceptor sits on top for callers that prefer the HTTP-layer
    // affordance. Mirrors the service-booking / service-provider /
    // service-subscription wiring.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Cluster-shared across services; per-service
     * namespacing is enforced inside `@taste-and-see/nest-idempotency`
     * via the `{env}:{service}:idempotency:{actor}:{hashedKey}` key
     * shape (CLAUDE.md §3.7).
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    /**
     * TTL for cached completed responses, in seconds. Default 86400
     * (24h) matches the CLAUDE.md §3.3 contract.
     */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /**
     * TTL for in-flight markers, in seconds. Default 60 — every
     * endpoint we cache returns well under a minute.
     */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(60),

    // ───────────────────────────────────────────────────────────────────
    // Outbox consumer (TS-271a-followup-1 / TS-272a-followup-1 /
    // TS-277a-followup-1). service-audit subscribes to the
    // `audit.action_recorded` Redis Stream (published by the outbox-relay
    // from every producer's outbox) and persists each event via
    // `recordEvent`. Mirrors the service-accounting consumer env cluster.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Consumer name within the `service-audit` group — distinguishes
     * pods so a crashed pod's in-flight entries can be reclaimed.
     * Production wires this to `process.env.HOSTNAME` (Kubernetes
     * injects the pod name); single-pod dev / test falls back to the
     * default. Mirrors the contract on `OutboxConsumerModule.forRoot`.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Stream prefix matching the relay's `STREAM_NAME_PREFIX`. Default
     * `events` keeps the consumer aligned with the relay default;
     * override both ends together if a deployment customises the prefix.
     */
    OUTBOX_STREAM_PREFIX: z.string().min(1).default('events'),
    /**
     * Maximum redeliveries before a row dead-letters. 10 attempts at the
     * default 60s reclaim interval gives ~10 minutes of redelivery —
     * enough to ride out a transient Postgres failover.
     */
    OUTBOX_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /**
     * XREADGROUP BLOCK argument (ms). Higher = less Redis traffic;
     * lower = faster shutdown response. 5000 mirrors the SDK default.
     */
    OUTBOX_CONSUMER_POLL_BLOCK_MS: z.coerce.number().int().nonnegative().default(5000),
    /**
     * XAUTOCLAIM idle threshold (ms). Entries pending past this become
     * eligible for reclaim from a crashed pod. 60s matches the SDK
     * default + a typical Kubernetes pod-disruption window.
     */
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
    /**
     * Gap between scheduler ticks when BLOCK returns empty (ms). Keeps
     * the consumer responsive without hammering Redis when quiet.
     */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1000),
    // ───────────────────────────────────────────────────────────────────
    // OpenTelemetry (TS-306-followup-1d). This workload emitted no metrics
    // and no traces at all until now — no SDK init, no meter provider —
    // against CLAUDE.md §10's "every service emits". Same coercion shape as
    // service-ads / service-trust-safety. PDD §20.5.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Toggle OTel tracing init. Defaults true; flip to false to short-circuit
     * `initTracing` (e.g. CI runs that don't ship spans to a collector).
     * Consulted at boot, before any service module loads.
     */
    OTEL_TRACES_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Toggle OTel metrics init. Same coercion shape as `OTEL_TRACES_ENABLED`.
     * The `/metrics` scrape endpoint stays wired regardless — when false the
     * handler returns an empty exposition document so Prometheus's
     * missing-target alert does not fire.
     */
    OTEL_METRICS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Optional explicit OTLP exporter endpoint override. When unset the tracing
     * package falls back to the standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` /
     * `OTEL_EXPORTER_OTLP_ENDPOINT` env vars and ultimately
     * `http://localhost:4318/v1/traces`. Re-declared here with `.url()` so a
     * typo fails boot rather than surfacing as a late-running silent exporter
     * error.
     */
    /**
     * Sentry DSN (CLAUDE.md §10 — "Errors: Sentry with release tagging").
     *
     * Optional, and its ABSENCE is the off switch: a service must still boot
     * when error reporting is not configured, so `createObservabilityBootstrap`
     * reports `{ enabled: false, reason: 'no_dsn' }` instead of failing. A
     * second enable/disable flag is not offered — two knobs that can
     * contradict each other is how a workload ends up configured-but-silent.
     *
     * Declared here even though `initSentry` reads `process.env` directly (it
     * runs before Zod, as the OTEL flags do) for two reasons: TS-153's
     * key-pick drops undeclared keys, and the `.env.example` drift guard
     * requires every documented assignment to have a consumer that reads it.
     *
     * `.url()` so a malformed DSN fails boot rather than silently disabling
     * reporting on a pod that looks healthy.
     */
    SENTRY_DSN: z
      .string()
      .url('SENTRY_DSN must be a valid URL')
      // An EMPTY value means "declared, off" — the state `.env.example`
      // needs to express. `initSentry` already treats '' as absent, so the
      // schema has to agree with it or the documented file would fail boot.
      .or(z.literal(''))
      .optional(),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .string()
      .url('OTEL_EXPORTER_OTLP_ENDPOINT must be a valid URL')
      .optional(),
  })
  .strict();

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`service-audit env validation failed: ${EnvValidationError.format(issues)}`);
    this.name = 'EnvValidationError';
  }

  private static format(issues: z.ZodIssue[]): string {
    return issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // TS-153: pick only the keys this schema declares before validating.
  // A pod's process.env carries ambient (PATH/HOME/HOSTNAME) and
  // Kubernetes-injected (POD_*, <SERVICE>_SERVICE_HOST/_SERVICE_PORT)
  // variables. The `.strict()` env schema validated against the raw env
  // would reject those undeclared keys and CrashLoop the pod at boot.
  // Stripping them here keeps strict validation on OUR config (a typo’d or
  // missing required var still fails) while tolerating the open 12-factor
  // env namespace.
  // `EnvSchema` is a plain strict ZodObject for most services and a
  // ZodEffects (object wrapped in a cross-field `.superRefine`) for others;
  // `.shape` lives on the object, reachable via `.sourceType()` when wrapped.
  const envObjectSchema = (
    EnvSchema instanceof z.ZodEffects ? EnvSchema.sourceType() : EnvSchema
  ) as z.ZodObject<z.ZodRawShape>;
  const declaredEnvKeys = new Set(Object.keys(envObjectSchema.shape));
  const scopedEnv = Object.fromEntries(
    Object.entries(source).filter(([key]) => declaredEnvKeys.has(key)),
  );
  const parsed = EnvSchema.safeParse(scopedEnv);
  if (!parsed.success) {
    throw new EnvValidationError(parsed.error.issues);
  }
  return parsed.data;
}
