import { z } from 'zod';

/**
 * Environment-variable schema for service-accounting.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Layered surface:
 *   1. **Skeleton** (TS-080) — DATABASE_URL + standard NODE_ENV/PORT/etc.
 *      Powers the read-only chart-of-accounts catalog endpoint.
 *   2. **Access-token verification** (TS-080) — JWT_ACCESS_SECRET +
 *      audience/issuer pins. The catalog endpoint is staff-only
 *      (CLAUDE.md §6 — accounting is "surgery"); a leaked chart-of-
 *      accounts is not a customer-data incident but the discipline of
 *      gating reads is the right default for the financial-source-of-
 *      truth service. Mirrors the contract used by service-subscription
 *      and service-provider.
 *   3. **Journal posting** (TS-081) — `REDIS_URL` +
 *      `IDEMPOTENCY_*_SECONDS` powering `@taste-and-see/nest-idempotency`
 *      for the write endpoints; `INTERNAL_POST_JOURNAL_API_KEY` is the
 *      shared-secret pinned on `POST /api/v1/internal/journals` for
 *      service-to-service calls (the outbox relay).
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3015`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014. New
     * services pick the next-available port to keep the local dev
     * runbook predictable.
     */
    PORT: z.coerce.number().int().positive().default(3015),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification (TS-080). service-accounting consumes
    // JWTs minted by service-identity. Same HS256-shared-secret contract
    // as service-subscription / service-provider; flips to RS256 with
    // TS-022-followup-2 once a second verifier (gateway-api, TS-140)
    // exists.
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
     * Pinned issuer claim — must match the `JWT_ISSUER` configured on
     * service-identity. A token issued by an unrelated service (or a
     * compromised secondary issuer) will not pass even if the secret
     * matches by accident.
     */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /**
     * Pinned audience claim. Same default as service-identity's
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
    // Journal posting (TS-081). Redis backs the Idempotency-Key replay
    // cache via `@taste-and-see/nest-idempotency`; the internal API key
    // pins the system-driven POST /api/v1/internal/journals endpoint
    // against service-to-service callers (the TS-142 outbox relay).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Same instance the rest of the platform's
     * services connect to — `nest-idempotency` namespaces its keys per
     * `{env}:service-accounting:idemp:...` so cross-service collisions
     * are impossible.
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port)'),

    /**
     * Idempotency-Key cache TTL (24h default — CLAUDE.md §3.3). A
     * replay of a write within this window returns the cached
     * response shape verbatim.
     */
    IDEMPOTENCY_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24),

    /**
     * In-flight claim TTL — bounds how long a concurrent retry waits
     * before being permitted to retry its own first attempt. Short
     * enough that a transient network glitch unblocks quickly, long
     * enough that a slow downstream (Stripe at p99) finishes its work
     * first. 30s mirrors `service-subscription`.
     */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(30),

    /**
     * Shared-secret header value pinning the internal journal post
     * endpoint. The outbox relay (TS-142) reads the same value from
     * its own env and presents it on every dispatch. Pre-TS-142
     * (synchronous HTTP scaffold) the same contract applies — any
     * service-to-service caller carries this header.
     */
    INTERNAL_POST_JOURNAL_API_KEY: z
      .string()
      .min(32, 'INTERNAL_POST_JOURNAL_API_KEY must be at least 32 characters of entropy'),

    // ───────────────────────────────────────────────────────────────────
    // Outbox consumer (TS-142-followup-2-followup-2). Wires the
    // `@taste-and-see/nest-outbox-consumer` SDK against the
    // service-accounting deployment so subscription.activated events
    // emitted by service-subscription (via the relay) drive the
    // revenue-recognition activation flow. The Redis client comes from
    // REDIS_URL above (single Redis instance shared with the
    // Idempotency-Key cache).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Per-pod consumer name inside the Redis consumer group. Two pods
     * MUST present distinct names so Redis tracks each pod's
     * in-flight Pending Entries List independently. Production wires
     * this to `process.env.HOSTNAME` (Kubernetes injects the pod
     * name); single-pod dev / test environments fall back to the
     * default. Mirrors the contract documented on
     * `OutboxConsumerModule.forRoot`.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Stream prefix matching the relay's `STREAM_NAME_PREFIX`. Default
     * `events` keeps the consumer aligned with the relay default;
     * override both ends together if a deployment customises the
     * prefix.
     */
    OUTBOX_STREAM_PREFIX: z.string().min(1).default('events'),
    /**
     * Maximum redeliveries before a row dead-letters. 10 attempts at
     * the default 60s reclaim interval gives ~10 minutes of
     * redelivery — enough to ride out a transient Postgres failover
     * without burning ops attention on a permanently-broken event.
     */
    OUTBOX_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /**
     * XREADGROUP BLOCK argument (ms). Higher = less Redis traffic;
     * lower = faster shutdown response. 5000 mirrors the SDK default
     * and the relay's polling cadence.
     */
    OUTBOX_CONSUMER_POLL_BLOCK_MS: z.coerce.number().int().nonnegative().default(5000),
    /**
     * XAUTOCLAIM idle threshold (ms). Entries pending past this
     * become eligible for reclaim from a crashed pod. 60s matches
     * the SDK default + a typical Kubernetes pod-disruption window.
     */
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
    /**
     * Gap between scheduler ticks when BLOCK returns empty (ms).
     * Keeps the consumer responsive without hammering Redis when the
     * stream is quiet.
     */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1000),

    // ───────────────────────────────────────────────────────────────────
    // Stripe → ledger reconciliation (TS-261). The daily reconciliation
    // worker triggers `POST /api/v1/internal/accounting/stripe-reconciliation/run`
    // (same `INTERNAL_POST_JOURNAL_API_KEY` trust principal as every other
    // `/api/v1/internal/*` endpoint). The reconciliation reads Stripe's
    // reported balance + balance-transaction activity via the SDK and
    // compares them against the platform ledger's Cash account; mismatches
    // beyond the tolerance land as ops tickets (CLAUDE.md §6).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Stripe secret key. OPTIONAL — Phase 1 stub-mode-friendly. When absent
     * (or the explicit `sk_test_stub_*` sentinel is set), the reconciliation
     * runs in STUB mode: it cannot query Stripe, so it records a
     * `skipped_stub` check carrying the ledger figures with null Stripe
     * figures and raises no ticket. Live SDK wiring is TS-261-followup-1.
     * Mirrors the optional-secret stub posture in service-payouts.
     */
    STRIPE_SECRET_KEY: z.string().min(1).optional(),

    /**
     * Stripe API version pin. Mirrors service-subscription / service-payouts
     * / service-webhook's pinned version so the SDK's request/response shape
     * is stable across a future SDK minor bump.
     */
    STRIPE_API_VERSION: z.string().min(1).default('2024-12-18.acacia'),

    /**
     * Absolute mismatch tolerance in USD minor units (cents). A check whose
     * `|delta| > tolerance` flags a `mismatch_open` ops ticket. Default 0 —
     * any divergence between Stripe and the ledger is surfaced for review
     * (CLAUDE.md §6 "do not auto-correct silently"); ops can raise the
     * tolerance if a known, explained, recurring divergence creates noise.
     */
    STRIPE_RECONCILIATION_TOLERANCE_MINOR: z.coerce.number().int().nonnegative().default(0),
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
    super(`service-accounting env validation failed: ${EnvValidationError.format(issues)}`);
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

/**
 * The Stripe reconciliation runs in STUB mode when no live secret key is
 * supplied OR the explicit `sk_test_stub_*` sentinel is set. Exposed as a
 * helper so the reader + tests read the same predicate (mirrors
 * service-payouts' `isStripeStubMode`).
 */
export function isStripeStubMode(env: Env): boolean {
  if (env.STRIPE_SECRET_KEY === undefined) return true;
  if (env.STRIPE_SECRET_KEY.startsWith('sk_test_stub_')) return true;
  return false;
}
