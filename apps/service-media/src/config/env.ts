import { z } from 'zod';

/**
 * Environment-variable schema for service-media.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11).
 *
 * Clusters of env shipping with TS-110:
 *
 *   - Skeleton — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION`.
 *
 *   - Admin authentication — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *     `JWT_AUDIENCE`. service-media verifies access tokens minted by
 *     service-identity for the provider-self-service + admin endpoints.
 *
 *   - S3 storage — `S3_BUCKET_NAME` (required, even in stub mode — the
 *     stub URL embeds it), `S3_REGION` (defaults to `us-east-1`),
 *     `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (both optional;
 *     absence forces stub mode), `S3_ENDPOINT_URL` (optional override
 *     for localstack / MinIO during dev), `S3_FORCE_PATH_STYLE`
 *     (optional bool for non-AWS-shaped endpoints),
 *     `S3_UPLOAD_URL_TTL_SECONDS` (TTL for the upload signed URL —
 *     default 900 s = 15 min), `S3_DELIVERY_URL_TTL_SECONDS` (TTL for
 *     the read-side signed delivery URL — default 300 s = 5 min),
 *     `S3_SIGNING_SECRET` (HMAC secret for stub-mode signatures; live
 *     mode uses sigv4 instead).
 *
 *   - Internal scan-events ingest — `MEDIA_SCAN_EVENTS_HEADER_NAME` /
 *     `MEDIA_SCAN_EVENTS_API_KEY`. media-processor (TS-110-followup-1)
 *     posts each pipeline stage event here with this shared-secret
 *     header. The TS-151 NetworkPolicy will restrict the route to
 *     in-cluster callers; the header is application-layer
 *     defence-in-depth.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3019`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking = 3015, audit = 3016, notification = 3017,
     * payouts = 3018. service-media takes the next-available port so
     * the local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3019),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-110 — JWT access-token verification. service-media consumes
    // JWTs minted by service-identity for the provider-self-service +
    // admin endpoints.
    // ───────────────────────────────────────────────────────────────────

    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
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
    // TS-110 — S3 storage. The access key + secret are OPTIONAL; when
    // absent the service runs in stub mode (deterministic synthetic
    // upload + delivery URLs minted with an HMAC signature against
    // `S3_SIGNING_SECRET`).
    // ───────────────────────────────────────────────────────────────────

    S3_BUCKET_NAME: z
      .string()
      .min(1, 'S3_BUCKET_NAME is required (the stub URL embeds the bucket name)')
      .max(63, 'S3_BUCKET_NAME must be at most 63 characters (S3 limit)'),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /**
     * Optional override of the S3 endpoint — useful for localstack /
     * MinIO during dev / CI without coupling the service code.
     */
    S3_ENDPOINT_URL: z.string().url('S3_ENDPOINT_URL must be a valid URL').optional(),
    /**
     * Optional override of S3 path-style addressing — useful for
     * non-AWS-shaped endpoints (localstack default).
     */
    S3_FORCE_PATH_STYLE: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .default('false'),
    /**
     * TTL for the upload signed URL — Stripe-like 10-minute window in
     * live mode; we default to 15 minutes for stub mode to keep the
     * dev runbook ergonomic. Capped at one hour to keep replay attack
     * windows bounded (CLAUDE.md §3.4).
     */
    S3_UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
    /**
     * TTL for the read-side signed delivery URL. Short — 5 minutes —
     * because the family / provider client refetches on render. The
     * delivery URL is generated per-read so the URL is never
     * persistently shareable.
     */
    S3_DELIVERY_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
    /**
     * HMAC-SHA256 secret for stub-mode URL signatures. Required even
     * in live mode — the service uses it to sign internal "presence
     * proofs" embedded in delivery URLs (so an admin browsing the
     * dev DB can't forge a delivery URL just by reading the storage
     * key).
     */
    S3_SIGNING_SECRET: z
      .string()
      .min(32, 'S3_SIGNING_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),

    // ───────────────────────────────────────────────────────────────────
    // TS-110 — Internal scan-events ingest shared secret. media-processor
    // (TS-110-followup-1) posts pipeline stage events here.
    // ───────────────────────────────────────────────────────────────────

    MEDIA_SCAN_EVENTS_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    MEDIA_SCAN_EVENTS_API_KEY: z
      .string()
      .min(32, 'MEDIA_SCAN_EVENTS_API_KEY must be at least 32 characters'),
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
    super(`service-media env validation failed: ${EnvValidationError.format(issues)}`);
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
 * S3 SDK runs in stub mode when no live access key + secret are
 * supplied. Exposed as a helper so every caller (SignedUrlIssuerService
 * + tests + admin tooling) reads the same predicate.
 */
export function isS3StubMode(env: Env): boolean {
  if (env.S3_ACCESS_KEY_ID === undefined) return true;
  if (env.S3_SECRET_ACCESS_KEY === undefined) return true;
  return false;
}
