import { z } from 'zod';

/**
 * Environment-variable schema for service-messaging.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-070 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (skeleton). Only Postgres-side env at this
 *     stage because TS-070 ships the thread + thread-participants
 *     metadata tables + `/healthz` + `/readyz` only — no authenticated
 *     HTTP surface yet.
 *
 *   - TS-070-followup-1 will add Cassandra contact points + keyspace
 *     (`cassandra-driver` is on the approved-libraries list per
 *     CLAUDE.md §13) for the message-body store.
 *
 *   - TS-071 adds the Socket.IO + Redis-adapter env for real-time
 *     fan-out (PDD §13.1):
 *       * `REDIS_URL`               — pub/sub backplane connection URL.
 *       * `REDIS_KEY_NAMESPACE_PREFIX` — `{env}:{service}:{purpose}:...`
 *         prefix the Redis adapter pins per CLAUDE.md §3.7.
 *       * `WS_PATH`                 — Socket.IO mount path (default
 *         `/socket.io`).
 *       * `WS_CORS_ORIGINS`         — comma-separated allowlist of
 *         browser origins permitted to open a handshake (CLAUDE.md
 *         §3.1 / OWASP CORS hygiene).
 *       * `JWT_ACCESS_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE` — HS256
 *         verification cluster, twin of service-identity. The gateway
 *         verifies handshake tokens against this exact triple so a
 *         token minted for a different audience cannot establish a
 *         realtime session.
 *
 *   - The authenticated HTTP surface (when it lands as TS-070-followup
 *     or later) will reuse the JWT cluster from TS-071 + add the
 *     idempotency cache (`REDIS_URL` + TTLs), mirroring service-booking
 *     / service-provider / service-household / service-subscription
 *     shape.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3017`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking = 3015, audit = 3016. The messaging service gets the
     * next-available port so the local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3017),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-071 — Real-time delivery (Socket.IO + Redis adapter, PDD §13.1)
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis URL for the Socket.IO pub/sub backplane. Multi-pod fan-out
     * works by every pod publishing to a shared Redis channel; without
     * the adapter, two browsers connected to two different pods would
     * never see each other's messages.
     *
     * The adapter creates two ioredis connections (one publisher, one
     * subscriber) inside `RedisIoAdapter.connectToRedis()`. Both wire
     * `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` so a
     * Redis outage degrades to "single-pod delivery" rather than
     * stalling the request path (CLAUDE.md §4.3 "caches are best-
     * effort").
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    /**
     * Key prefix the Socket.IO Redis adapter pins on every published
     * channel name. Shape: `{env}:service-messaging:socket:` per
     * CLAUDE.md §3.7 ("No flat keys"). Defaulted from `NODE_ENV` at
     * runtime if unset — staging and production overrides via env.
     *
     * The trailing colon is significant — the adapter appends its own
     * suffix (room name, namespace, ...) and the segments should be
     * colon-delimited.
     */
    REDIS_KEY_NAMESPACE_PREFIX: z.string().min(1).default('dev:service-messaging:socket:'),
    /**
     * Socket.IO mount path. Default matches the client SDK's default
     * (`/socket.io`) so the family / provider portals can connect with
     * `io(url)` and zero config. Phase-2 may move this behind a path
     * prefix (`/api/v1/socket.io`) so an ingress can route by path
     * without a separate Service.
     */
    WS_PATH: z.string().min(1).default('/socket.io'),
    /**
     * Comma-separated allowlist of browser origins permitted to open a
     * realtime handshake. Empty string disables CORS entirely (server-
     * to-server only). Wildcards are NOT supported — a wildcard origin
     * combined with `credentials: true` is the OWASP CORS misconfig
     * pattern we explicitly want to avoid.
     */
    WS_CORS_ORIGINS: z.string().default(''),

    /**
     * HS256 verification secret. Twin of service-identity's
     * `JWT_ACCESS_SECRET`; in Phase 1 the shared secret is distributed
     * via the env manager (TS-150 Terraform-managed secrets) so every
     * verifier holds the same value. RS256 migration is captured as
     * TS-022-followup-2 — at that point service-identity holds the
     * private key and every verifier (including this gateway) pulls a
     * public-key PEM.
     *
     * Minimum length 32 bytes (HMAC-SHA256 block size) — guards
     * against an accidental short dev secret reaching staging.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /** Issuer claim. Tokens with a different `iss` are rejected. */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /** Audience claim. Tokens with a different `aud` are rejected. */
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
    // Idempotency cache (TS-070-followup-2). Backs the @Idempotent()
    // interceptor exposed by @taste-and-see/nest-idempotency on the thread
    // CRUD write endpoints (create thread / add participant / remove
    // participant). CLAUDE.md §3.3 / §17.5. Reuses the `REDIS_URL` already
    // declared above (TS-071); per-service namespacing is enforced inside
    // the package via the `{env}:{service}:idempotency:{actor}:{hashedKey}`
    // key shape (CLAUDE.md §3.7). A Redis outage degrades the interceptor to
    // "proceed without cache" (CLAUDE.md §4.3). Same wiring shape as
    // service-concierge / service-household / service-subscription.
    // ───────────────────────────────────────────────────────────────────

    /** TTL for cached completed responses, in seconds. Default 86400 (24h) per CLAUDE.md §3.3. */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /** TTL for in-flight markers, in seconds. Default 60. */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(60),
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
    super(`service-messaging env validation failed: ${EnvValidationError.format(issues)}`);
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
 * Parse the comma-separated CORS origins list into an array of strings.
 * Returns `[]` for the empty-string default (server-to-server only
 * deployments). Trims whitespace + drops empty entries from accidental
 * trailing commas.
 */
export function parseCorsOrigins(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
