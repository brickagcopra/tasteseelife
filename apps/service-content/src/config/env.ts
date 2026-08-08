import { z } from 'zod';

/**
 * Environment-variable schema for service-content.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-280 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (skeleton). Only Postgres-side env at this stage
 *     because TS-280 ships the `pages` / `page_versions` / `articles` /
 *     `article_versions` / `help_categories` tables + `/healthz` + `/readyz`
 *     only — there is no authenticated HTTP surface yet. This mirrors the
 *     service-ads (TS-270) / service-concierge (TS-221) / service-messaging
 *     (TS-070) "no dead config in the skeleton" convention.
 *
 *   - TS-284 (static-pages CMS) is the first authenticated authoring surface;
 *     it brings the access-token-verification cluster (`JWT_ACCESS_SECRET` /
 *     `JWT_ISSUER` / `JWT_AUDIENCE`) for the `AccessTokenGuard` +
 *     `PermissionGuard` (`content:read` / `content:edit` / `content:publish`)
 *     plus the idempotency cache
 *     (`REDIS_URL` + TTLs) for the first write endpoint — mirroring the
 *     service-academy / service-ads shape.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3025`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking/accounting = 3015, audit = 3016, messaging/notification = 3017,
     * activity/payouts = 3018, media = 3019, search = 3020, concierge = 3021,
     * academy = 3022, analytics = 3023, ads = 3024. The content service gets
     * the next-available port so the local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3025),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification (TS-284). service-content consumes JWTs
    // minted by service-identity (TS-022); the AccessTokenGuard verifies the
    // signature, audience, and issuer before any authenticated content-admin
    // handler (page authoring, gated on `content:read` / `content:edit` /
    // `content:publish`) sees the request. Phase 1 is HS256 with a shared
    // secret. Same contract as service-ads / service-academy.
    // ───────────────────────────────────────────────────────────────────

    /**
     * HS256 verification secret for access tokens issued by service-identity.
     * Same value as service-identity's `JWT_ACCESS_SECRET` — sharing a
     * symmetric secret across the issuer and verifier is the Phase 1 contract.
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
    // Idempotency cache (TS-284). Backs the @Idempotent() interceptor exposed
    // by @taste-and-see/nest-idempotency on the content-admin write endpoints
    // (CLAUDE.md §3.3 / §17.5). Same wiring shape as service-ads / service-academy.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Cluster-shared; per-service namespacing is enforced
     * inside the package via the `{env}:{service}:idempotency:{actor}:{hashedKey}`
     * key shape (CLAUDE.md §3.7). A Redis outage degrades the interceptor to
     * "proceed without cache" (CLAUDE.md §4.3).
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    /** TTL for cached completed responses, in seconds. Default 86400 (24h) per CLAUDE.md §3.3. */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /** TTL for in-flight markers, in seconds. Default 60. */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(60),

    // ───────────────────────────────────────────────────────────────────
    // OpenTelemetry (TS-306-followup-1c). service-content carried a
    // `@taste-and-see/tracing` dependency and a domain instrument
    // (`PublicBlogMetrics`, TS-282-followup-3) with NO SDK init anywhere —
    // so `getMeter` handed it a no-op and the counter read as
    // instrumentation while reporting nothing. That is the exact failure
    // mode TS-306-followup-1a refused to ship into on trust-safety; here it
    // was already live. CLAUDE.md §10; PDD §20.5. Same coercion shape as
    // service-ads.
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
    super(`service-content env validation failed: ${EnvValidationError.format(issues)}`);
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
  // Stripping them here keeps strict validation on OUR config (a typo'd or
  // missing required var still fails) while tolerating the open 12-factor
  // env namespace.
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
