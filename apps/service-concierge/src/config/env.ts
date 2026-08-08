import { z } from 'zod';

/**
 * Environment-variable schema for service-concierge.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-221 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (skeleton). Only Postgres-side env at this stage
 *     because TS-221 ships the `concierge_tickets` table + `/healthz` +
 *     `/readyz` only — there is no authenticated HTTP surface yet.
 *
 *   - TS-222 (dedicated-concierge assignment) brings the
 *     access-token-verification cluster (`JWT_ACCESS_SECRET` /
 *     `JWT_ISSUER` / `JWT_AUDIENCE`) for the `AccessTokenGuard` plus the
 *     idempotency cache (`REDIS_URL` + TTLs) for the first write
 *     endpoint — mirroring the service-household / service-booking /
 *     service-subscription shape. The skeleton (TS-221) carried no dead
 *     config (the TS-070 service-messaging skeleton convention); these
 *     clusters land now that the first authenticated write surface does.
 *
 *   - TS-225 (emergency concierge assistance) brings the PagerDuty Events
 *     API v2 cluster (`PAGERDUTY_ROUTING_KEY` / `PAGERDUTY_EVENTS_URL` /
 *     `PAGERDUTY_SOURCE` / `PAGERDUTY_TIMEOUT_MS`) for the on-call page.
 *     The routing key is OPTIONAL so the service boots + the emergency
 *     ticket is always created even when paging is not yet configured.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3021`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking = 3015, audit = 3016, messaging/notification = 3017,
     * activity/payouts = 3018, media = 3019, search = 3020. The
     * concierge service gets the next-available port so the local dev
     * runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3021),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification (TS-222). service-concierge consumes JWTs
    // minted by service-identity (TS-022); the AccessTokenGuard verifies
    // the signature, audience, and issuer before any authenticated handler
    // sees the request. Phase 1 is HS256 with a shared secret; Phase 2
    // (TS-022-followup-2) flips to RS256. Same contract as
    // service-household / service-subscription.
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
    // Idempotency cache (TS-222). Backs the @Idempotent() interceptor
    // exposed by @taste-and-see/nest-idempotency. CLAUDE.md §3.3 / §17.5.
    // Same wiring shape as service-household / service-subscription.
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
    // PagerDuty paging (TS-225). The emergency concierge channel pages the
    // on-call supervisor via the PagerDuty Events API v2 (a plain HTTPS
    // POST — no SDK / approved-library change, PDD §20.5). The routing key
    // is OPTIONAL: when unset the service still creates the high-severity
    // escalated ticket and logs a warning, so the durable ticket is always
    // the source of truth (CLAUDE.md §16 — degrade gracefully). The key is
    // a secret sourced from Vault / the cloud secret manager in real
    // environments (CLAUDE.md §3.5), never committed.
    // ───────────────────────────────────────────────────────────────────

    /**
     * PagerDuty Events API v2 routing (integration) key for the emergency
     * on-call service. Optional — unset disables paging (the ticket still
     * lands escalated). Validated as non-empty when present.
     */
    PAGERDUTY_ROUTING_KEY: z.string().min(1).optional(),
    /**
     * PagerDuty Events API v2 enqueue endpoint. Defaults to the public URL;
     * overridable for the EU service region or a test double.
     */
    PAGERDUTY_EVENTS_URL: z
      .string()
      .url('PAGERDUTY_EVENTS_URL must be a valid URL')
      .default('https://events.pagerduty.com/v2/enqueue'),
    /** `payload.source` on the PagerDuty event — names the emitter. */
    PAGERDUTY_SOURCE: z.string().min(1).default('service-concierge'),
    /**
     * Per-page request timeout in milliseconds. An emergency page must
     * resolve fast or fail fast (the ticket is already durable); the call
     * never blocks the HTTP response beyond this bound.
     */
    PAGERDUTY_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5_000),

    // ───────────────────────────────────────────────────────────────────
    // Transportation ride-status webhook (TS-226). The inbound
    // `POST /internal/concierge/transportation/ride-events` endpoint is
    // authenticated by a constant-time shared-secret header (webhook auth IS
    // the model — no ride-hailing edge logs in as a user, CLAUDE.md §3.5 /
    // §17.8). Mirrors the service-provider discovery-snapshot shape.
    //
    // The key is OPTIONAL: a Phase-1 deployment runs entirely on the `manual`
    // provider (no vendor POSTs events), so the secret is unset until the
    // Uber Health / Lyft Health integration lands (TS-226-followup). The guard
    // degrades CLOSED — when the key is unset it rejects EVERY request with a
    // 401 (a security gate must fail closed, unlike the best-effort PagerDuty
    // page above). The key is a secret sourced from Vault / the cloud secret
    // manager in real environments (CLAUDE.md §3.5), never committed.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Shared-secret header value for the internal ride-status webhook. A
     * ride-hailing vendor (Uber Health / Lyft Health) presents this as the
     * `x-concierge-transportation-internal-api-key` header (configurable via
     * `CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME`) on every POST; the guard
     * rejects with 401 on missing / wrong header, AND on a missing key
     * (fail-closed). Optional but min-length-32 when present for entropy.
     */
    CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY: z
      .string()
      .min(32, 'CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY must be at least 32 characters')
      .optional(),
    /**
     * Header name carrying the shared secret. Configurable per environment so
     * a future rename doesn't force a code change. Default matches the
     * convention used elsewhere (lowercase, dash-separated, `x-`-prefixed).
     */
    CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-concierge-transportation-internal-api-key'),
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
    super(`service-concierge env validation failed: ${EnvValidationError.format(issues)}`);
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
