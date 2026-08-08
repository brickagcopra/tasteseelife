import { z } from 'zod';

/**
 * Environment-variable schema for service-analytics.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-217-prep-2 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (the skeleton's Postgres-side config), plus the
 *     access-token-verification cluster (`JWT_ACCESS_SECRET` / `JWT_ISSUER`
 *     / `JWT_AUDIENCE`) for the platform-standard `NestAuthModule` wiring.
 *     There is no authenticated HTTP surface yet (`/healthz` + `/readyz`
 *     only) and no event consumers — but the auth wiring lands at skeleton
 *     time as part of the tenant-scope platform-rollout shape so the first
 *     read endpoint (the TS-217 admin dashboard proxy / TS-217-prep-3
 *     ingest) drops in without an env bump.
 *
 *   - TS-217-prep-3a — brings the event-bus / Redis cluster (`REDIS_URL` +
 *     the `OUTBOX_CONSUMER_*` config) now that service-analytics drains
 *     `search.performed` + `booking.created` via the
 *     `@taste-and-see/nest-outbox-consumer` SDK. Mirrors the
 *     service-accounting consumer-env cluster one-for-one.
 *
 *   - TS-217-prep-3b — brings `INTERNAL_AGGREGATION_API_KEY`, the shared
 *     secret pinning the internal search-relevance compute endpoint the
 *     `analytics-aggregator` worker calls nightly. The compute endpoint is
 *     idempotent (delete-and-reinsert keyed by UTC date) so the
 *     `@Idempotent()` decorator's Redis cache rides on the existing
 *     `REDIS_URL` with the SDK defaults (24h TTL).
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3023`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking/accounting = 3015, audit = 3016, messaging/notification = 3017,
     * activity/payouts = 3018, media = 3019, search = 3020, concierge = 3021,
     * academy = 3022. The analytics service gets the next-available port so
     * the local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3023),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification (TS-217-prep-2). service-analytics consumes
    // JWTs minted by service-identity (TS-022); the AccessTokenGuard verifies
    // the signature, audience, and issuer before any authenticated handler
    // sees the request. Phase 1 is HS256 with a shared secret; Phase 2
    // (TS-022-followup-2) flips to RS256. Same contract as every other Nest
    // service. Wired at skeleton time so the first read surface (the TS-217
    // admin dashboard read) needs no env bump.
    // ───────────────────────────────────────────────────────────────────

    /**
     * HS256 verification secret for access tokens issued by
     * service-identity. Same value as service-identity's
     * `JWT_ACCESS_SECRET` — sharing a symmetric secret across the issuer
     * and verifier is the Phase 1 contract.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /** Pinned issuer claim — must match service-identity's `JWT_ISSUER`. */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /** Pinned audience claim — must match service-identity's `JWT_AUDIENCE`. */
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
    // Outbox consumer (TS-217-prep-3a). Wires the
    // `@taste-and-see/nest-outbox-consumer` SDK against the
    // service-analytics deployment so `search.performed` (TS-217-prep-1) +
    // `booking.created` events — published to Redis Streams by the outbox
    // relay (TS-142) — drive the raw-event landing handlers. The Redis
    // client is built from `REDIS_URL`. Mirrors service-accounting's
    // consumer-env cluster one-for-one.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Same instance the rest of the platform's
     * services connect to — the consumer SDK's consumer group
     * (`service-analytics`) namespaces the per-pod delivery position so
     * cross-service collisions are impossible.
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port)'),

    /**
     * Per-pod consumer name inside the Redis consumer group. Two pods MUST
     * present distinct names so Redis tracks each pod's in-flight Pending
     * Entries List independently. Production wires this to
     * `process.env.HOSTNAME` (Kubernetes injects the pod name); single-pod
     * dev / test environments fall back to the default. Mirrors the
     * contract documented on `OutboxConsumerModule.forRoot`.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Stream prefix matching the relay's `STREAM_NAME_PREFIX`. Default
     * `events` keeps the consumer aligned with the relay default; override
     * both ends together if a deployment customises the prefix.
     */
    OUTBOX_STREAM_PREFIX: z.string().min(1).default('events'),
    /**
     * Maximum redeliveries before a row dead-letters. 10 attempts at the
     * default 60s reclaim interval gives ~10 minutes of redelivery — enough
     * to ride out a transient Postgres failover without burning ops
     * attention on a permanently-broken event.
     */
    OUTBOX_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /**
     * XREADGROUP BLOCK argument (ms). Higher = less Redis traffic; lower =
     * faster shutdown response. 5000 mirrors the SDK default + the relay's
     * polling cadence.
     */
    OUTBOX_CONSUMER_POLL_BLOCK_MS: z.coerce.number().int().nonnegative().default(5000),
    /**
     * XAUTOCLAIM idle threshold (ms). Entries pending past this become
     * eligible for reclaim from a crashed pod. 60s matches the SDK default
     * + a typical Kubernetes pod-disruption window.
     */
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
    /**
     * Gap between scheduler ticks when BLOCK returns empty (ms). Keeps the
     * consumer responsive without hammering Redis when the stream is quiet.
     */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1000),

    // ───────────────────────────────────────────────────────────────────
    // Search-relevance aggregation (TS-217-prep-3b). Shared secret pinning
    // the internal compute endpoint
    // (`POST /api/v1/internal/analytics/search-relevance/compute`) the
    // `analytics-aggregator` worker calls nightly. The worker presents the
    // SAME value in the `x-analytics-internal-api-key` header; rotation is a
    // two-side deploy. Mirrors service-accounting's
    // `INTERNAL_POST_JOURNAL_API_KEY` trust-principal convention.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Shared secret for the internal search-relevance compute endpoint.
     * Min 32 chars (HMAC-grade entropy); compared in constant time.
     */
    INTERNAL_AGGREGATION_API_KEY: z
      .string()
      .min(32, 'INTERNAL_AGGREGATION_API_KEY must be at least 32 characters'),
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
    super(`service-analytics env validation failed: ${EnvValidationError.format(issues)}`);
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
