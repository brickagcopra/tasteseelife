import { z } from 'zod';

/**
 * Environment-variable schema for service-academy.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-250 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (skeleton). Only Postgres-side env at this stage
 *     because TS-250 ships the six core tables + `/healthz` + `/readyz`
 *     only — there is no authenticated HTTP surface yet (the TS-070
 *     service-messaging / TS-221 service-concierge skeleton convention:
 *     no dead config).
 *
 *   - TS-251 (course-catalog admin) brings the access-token-verification
 *     cluster (`JWT_ACCESS_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE`) for the
 *     `AccessTokenGuard` plus the idempotency cache (`REDIS_URL` + TTLs) for
 *     the first write endpoints — mirroring the service-concierge /
 *     service-household / service-subscription shape. The skeleton (TS-250)
 *     carried no dead config (the TS-070 service-messaging convention);
 *     these clusters land now that the first authenticated surface does.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3022`: identity = 3011, household = 3021,
     * subscription = 3020, webhook = 3012, provider = 3018,
     * booking = 3016, audit = 3018, messaging = 3019,
     * notification = 3017, payouts = 3017, activity = 3015,
     * media = 3010, search = 3014, concierge = 3021, accounting = 3000.
     * The academy service gets the next-available port (3022) so the
     * local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3022),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification (TS-251). service-academy consumes JWTs
    // minted by service-identity (TS-022); the AccessTokenGuard verifies
    // the signature, audience, and issuer before any authenticated handler
    // sees the request. Phase 1 is HS256 with a shared secret; Phase 2
    // (TS-022-followup-2) flips to RS256. Same contract as
    // service-concierge / service-household / service-subscription.
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
    // Idempotency cache (TS-251). Backs the @Idempotent() interceptor
    // exposed by @taste-and-see/nest-idempotency. CLAUDE.md §3.3 / §17.5.
    // Same wiring shape as service-concierge / service-household.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Cluster-shared; per-service namespacing is
     * enforced inside the package via the
     * `{env}:{service}:idempotency:{actor}:{hashedKey}` key shape
     * (CLAUDE.md §3.7). A Redis outage degrades the interceptor to
     * "proceed without cache" (CLAUDE.md §4.3).
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    /** TTL for cached completed responses, in seconds. Default 86400 (24h) per CLAUDE.md §3.3. */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /** TTL for in-flight markers, in seconds. Default 60. */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(60),

    // ───────────────────────────────────────────────────────────────────
    // Certification issuance (TS-255). PRD §9.3; PDD §15.2.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Public base URL the rendered certificate PDF prints its verification
     * link against (`{ACADEMY_PUBLIC_BASE_URL}/verify/cert/{token}`). The
     * `/verify/cert/:token` route itself lives on the public web surface; this
     * service only needs the origin to embed the absolute URL on the PDF.
     * No trailing slash — the service joins the path. Default is the example
     * origin so dev/test render a recognisable, non-routable link
     * (CLAUDE.md §17.11 — never hardcode environment-dependent values).
     */
    ACADEMY_PUBLIC_BASE_URL: z
      .string()
      .url('ACADEMY_PUBLIC_BASE_URL must be a valid URL (https://host)')
      .default('https://app.tasteandsee.example.com'),

    // ───────────────────────────────────────────────────────────────────
    // Certification renewals — internal worker surface (TS-256). PRD §9.3;
    // PDD §15.2. The renewal-reminder worker reads the at-risk
    // certifications batch + issues the lapse `expire` write over a
    // shared-secret-pinned in-cluster call (the CLAUDE.md §3.5 Stripe-webhook
    // pattern: the header value IS the auth model). Mirrors service-identity's
    // `IDENTITY_RECIPIENT_CONTACTS_*` cluster (TS-235).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Shared secret pinning the internal renewals surface
     * (`/api/v1/internal/academy/certifications/renewals` +
     * `…/:certificationId/expire`). Min 32 chars — defence against a short /
     * guessable key. Held in Vault / cloud secret manager (CLAUDE.md §3.5);
     * the worker presents the same value.
     */
    ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_API_KEY: z
      .string()
      .min(32, 'ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_API_KEY must be at least 32 characters'),
    /** Header the worker presents the shared secret on. Default x-internal-api-key. */
    ACADEMY_CERTIFICATION_RENEWALS_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-internal-api-key'),
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
    super(`service-academy env validation failed: ${EnvValidationError.format(issues)}`);
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
