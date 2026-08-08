import { z } from 'zod';

/**
 * Environment-variable schema for the api-gateway (TS-140).
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11).
 *
 * Clusters of env shipping with TS-140:
 *
 *   - Skeleton — `PORT`, `LOG_LEVEL`, `NODE_ENV`, `SERVICE_VERSION`.
 *     **No `DATABASE_URL`** — the gateway owns no Postgres schema; it
 *     is a routing + auth + rate-limit + aggregation surface only.
 *
 *   - JWT verification — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *     `JWT_AUDIENCE`. The gateway verifies service-identity-minted
 *     access tokens ONCE at the edge and propagates the decoded actor
 *     identity to downstream services via signed-trust headers below.
 *     Today HS256 (the secret is shared between identity + gateway);
 *     RS256 with a public key lands when a second verifier exists
 *     (TS-022-followup-2).
 *
 *   - Internal-trust signing — `INTERNAL_TRUST_SIGNING_SECRET`. HMAC-
 *     SHA256 key used to sign the actor-identity envelope the gateway
 *     attaches to every outbound downstream call. Each downstream
 *     service holds the same secret and verifies the signature before
 *     trusting the propagated `x-ts-actor-*` headers — once
 *     TS-140-followup-1 wires that side. ≥ 32 chars per HMAC block-size
 *     mandate.
 *
 *   - Redis (rate limiting) — `REDIS_URL`. Sliding-window rate limiter
 *     stores per-(actor, route) request timestamps in a sorted set.
 *     Required even when rate limiting is best-effort (CLAUDE.md §4.3
 *     "caches are best-effort: code must work correctly when Redis is
 *     unavailable") because the readiness probe pings it.
 *
 *   - Downstream services — one `{NAME}_SERVICE_BASE_URL` per
 *     downstream backend. Only the services the gateway proxies in
 *     Phase 1 are required; the remainder land additively as the
 *     gateway grows aggregation surfaces. Required for Phase 1:
 *     subscription (the `/api/v1/plans` proxy). Optional for Phase 1
 *     (the gateway boots without them but readiness reports them as
 *     `not_configured`): identity, household, provider, booking,
 *     search, media, notification, audit, payouts, accounting,
 *     concierge, academy, analytics, ads.
 *
 *   - Rate-limit tuning — `RATE_LIMIT_DEFAULT_WINDOW_SECONDS` /
 *     `RATE_LIMIT_DEFAULT_MAX_REQUESTS` for the default policy applied
 *     to every route, plus `RATE_LIMIT_SENSITIVE_WINDOW_SECONDS` /
 *     `RATE_LIMIT_SENSITIVE_MAX_REQUESTS` for the tighter policy
 *     applied to login / signup / coupon-validate / similar surfaces
 *     (CLAUDE.md §3.1 IP-level circuit breaker, §3.7 Redis namespacing).
 *
 *   - Downstream call tuning — `DOWNSTREAM_REQUEST_TIMEOUT_MS` is the
 *     per-call AbortController-backed timeout for outbound proxies.
 *     Bounded to [500, 30000] so a deploy-time typo can't disable the
 *     timeout entirely.
 *
 *   - Internal shared secrets — two pairs in Phase 1:
 *     `HOUSEHOLD_VISIT_PREP_INTERNAL_*` (TS-208 prep-checklist
 *     aggregator) and `SEARCH_INDEX_*` (TS-211-followup-1 admin
 *     ranking-config proxy). Both are optional at the env layer so the
 *     gateway boots without them; the dependent endpoint returns 503
 *     with a specific detail line when called.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3000`: the gateway is the public-facing surface
     * — every other service takes a port in the 30xx range
     * (identity=3010, household=3011, …). The gateway lives at 3000
     * so the local-dev runbook is "hit localhost:3000 to talk to the
     * platform".
     */
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // JWT verification (service-identity-minted access tokens).
    // ───────────────────────────────────────────────────────────────────

    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    JWT_AUDIENCE: z.string().default('taste-and-see/api'),

    // ───────────────────────────────────────────────────────────────────
    // Internal-trust signing (HMAC-SHA256 over actor envelope).
    // ───────────────────────────────────────────────────────────────────

    INTERNAL_TRUST_SIGNING_SECRET: z
      .string()
      .min(
        32,
        'INTERNAL_TRUST_SIGNING_SECRET must be at least 32 characters (HMAC-SHA256 block size)',
      ),
    /**
     * Maximum age (in seconds) for the trust-header timestamp. Downstream
     * verifiers reject signatures older than this to bound replay-attack
     * windows. Default 60 s matches the JWT clock-tolerance discipline.
     */
    INTERNAL_TRUST_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(3600).default(60),

    // ───────────────────────────────────────────────────────────────────
    // Redis (rate-limit storage + the readiness probe).
    // ───────────────────────────────────────────────────────────────────

    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (e.g. redis://localhost:6379)'),

    // ───────────────────────────────────────────────────────────────────
    // Rate-limit policy.
    // ───────────────────────────────────────────────────────────────────

    RATE_LIMIT_DEFAULT_WINDOW_SECONDS: z.coerce.number().int().positive().max(3600).default(60),
    RATE_LIMIT_DEFAULT_MAX_REQUESTS: z.coerce.number().int().positive().max(100_000).default(120),
    /**
     * Sensitive routes (login, signup, password reset, coupon validate)
     * get a tighter sliding window. CLAUDE.md §3.1 — IP-level circuit
     * breaker for the login surface; §12 — coupon abuse prevention.
     */
    RATE_LIMIT_SENSITIVE_WINDOW_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
    RATE_LIMIT_SENSITIVE_MAX_REQUESTS: z.coerce.number().int().positive().max(10_000).default(20),

    // ───────────────────────────────────────────────────────────────────
    // Downstream call tuning.
    // ───────────────────────────────────────────────────────────────────

    DOWNSTREAM_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),

    // ───────────────────────────────────────────────────────────────────
    // Downstream service base URLs. Phase-1 required + optional split.
    // ───────────────────────────────────────────────────────────────────

    SUBSCRIPTION_SERVICE_BASE_URL: z
      .string()
      .url('SUBSCRIPTION_SERVICE_BASE_URL must be a valid URL'),

    IDENTITY_SERVICE_BASE_URL: z.string().url().optional(),
    HOUSEHOLD_SERVICE_BASE_URL: z.string().url().optional(),
    PROVIDER_SERVICE_BASE_URL: z.string().url().optional(),
    BOOKING_SERVICE_BASE_URL: z.string().url().optional(),
    SEARCH_SERVICE_BASE_URL: z.string().url().optional(),
    MEDIA_SERVICE_BASE_URL: z.string().url().optional(),
    NOTIFICATION_SERVICE_BASE_URL: z.string().url().optional(),
    AUDIT_SERVICE_BASE_URL: z.string().url().optional(),
    PAYOUTS_SERVICE_BASE_URL: z.string().url().optional(),
    ACCOUNTING_SERVICE_BASE_URL: z.string().url().optional(),
    CONCIERGE_SERVICE_BASE_URL: z.string().url().optional(),
    ACADEMY_SERVICE_BASE_URL: z.string().url().optional(),
    ANALYTICS_SERVICE_BASE_URL: z.string().url().optional(),
    ADS_SERVICE_BASE_URL: z.string().url().optional(),
    CONTENT_SERVICE_BASE_URL: z.string().url().optional(),
    TRUST_SAFETY_SERVICE_BASE_URL: z.string().url().optional(),

    // ───────────────────────────────────────────────────────────────────
    // Visit-prep internal shared secret (TS-208). The BFF aggregator
    // for `GET /api/v1/bookings/:bookingId/prep-checklist` calls
    // service-household's internal
    // `/api/v1/internal/seniors/:seniorId/prep-snapshot` endpoint
    // with this shared-secret header. Both sides MUST agree on header
    // name + value; rotation is a two-side deploy.
    //
    // Optional at the env layer because the prep-checklist endpoint
    // is itself optional Phase-1 surface — the gateway boots without
    // the shared secret, the prep-checklist endpoint returns 503 with
    // a specific detail line when called.
    // ───────────────────────────────────────────────────────────────────

    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-household-visit-prep-internal-api-key'),
    HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: z
      .string()
      .min(32, 'HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY must be at least 32 characters')
      .optional(),

    // ───────────────────────────────────────────────────────────────────
    // Household-scope resolution (TS-505d2-followup-5). The gateway calls
    // service-household's internal
    // `/api/v1/internal/users/:userId/household-memberships` endpoint to
    // turn an authenticated actor into a household `tenantScope` before
    // signing the trust envelope — the seam that makes CLAUDE.md §3.2's
    // household scoping reachable at all, since no access token has ever
    // carried anything but `global`.
    //
    // Optional at the env layer, matching the visit-prep pair above and
    // for the same reason: an unconfigured gateway must still boot. The
    // consequence of leaving it unset is explicit and logged once at
    // startup — every request stays `global`-scoped and every household-
    // scoped route refuses, which is exactly the platform's behaviour
    // before this seam existed. It fails CLOSED, never open.
    // ───────────────────────────────────────────────────────────────────

    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-household-memberships-internal-api-key'),
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: z
      .string()
      .min(32, 'HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY must be at least 32 characters')
      .optional(),
    /**
     * How long a user's membership list may be reused before it is
     * re-read. This is a cache over an AUTHORISATION input, so the TTL is
     * a security parameter, not a performance knob: it bounds how long a
     * revoked membership keeps working. 60s is the default because it is
     * fifteen times tighter than baking the scope into the 15-minute
     * access token (the alternative this design rejected) while still
     * collapsing the per-request hop for a normal browsing session.
     * Capped at 300 so nobody can quietly turn it into an hour.
     */
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(300, 'HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS must not exceed 300 (it bounds revocation lag)')
      .default(60),

    // ───────────────────────────────────────────────────────────────────
    // Search internal-index shared secret (TS-211-followup-1). The
    // admin search ranking-config BFF proxy
    // (`/api/v1/admin/search/ranking-config`) forwards super_admin-gated
    // writes to service-search's shared-secret-pinned internal endpoint
    // so the secret never reaches the browser. The header / value pair
    // mirrors service-search's `SEARCH_INDEX_*` env exactly — rotation
    // is a two-side deploy.
    //
    // Optional at the env layer because the admin ranking-config
    // surface is itself an admin-only Phase-1 convenience — the
    // gateway boots without it, the proxy returns 503 with a specific
    // detail line when called. Header name defaults to the same value
    // service-search defaults to.
    // ───────────────────────────────────────────────────────────────────

    SEARCH_INDEX_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    SEARCH_INDEX_API_KEY: z
      .string()
      .min(32, 'SEARCH_INDEX_API_KEY must be at least 32 characters')
      .optional(),
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
    super(`api-gateway env validation failed: ${EnvValidationError.format(issues)}`);
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
