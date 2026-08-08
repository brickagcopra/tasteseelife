import { z } from 'zod';

/**
 * Environment-variable schema for worker-search-indexer (TS-053).
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * The worker's job:
 *
 *   1. Subscribe via the `@taste-and-see/nest-outbox-consumer` SDK to
 *      the three provider domain-event streams on Redis Streams
 *      (`events:provider.tier_changed` / `.certification_granted`
 *      / `.certification_revoked`).
 *
 *   2. On each event, GET service-provider's internal
 *      discovery-snapshot endpoint to materialise the current
 *      `ProviderDiscoveryDocument`.
 *
 *   3. PUT the doc onto service-search's internal index endpoint.
 *
 * Both HTTP hops cross internal service boundaries; each leg presents
 * a shared-secret header pinned by the receiver's
 * `InternalSharedSecretGuard`. The headers are configurable so a
 * future SAN / DNS rename doesn't require a code change.
 */
const NonEmptySchema = z.string().min(1);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3051` — sits in the worker block above
     * worker-outbox-relay (3050). Used only by the `/healthz` +
     * `/readyz` HTTP endpoints; the actual work runs on a polling
     * timer driven by the consumer SDK's scheduler.
     */
    PORT: z.coerce.number().int().positive().default(3055),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SERVICE_VERSION: z.string().default('dev'),
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),

    // ───────────────────────────────────────────────────────────────────
    // Consumer SDK tuning — passed through to OutboxConsumerModule.forRoot.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis consumer-group name. By convention this is the consuming
     * service's name so each service has its own delivery position
     * across every event stream (two services consuming the same
     * stream form two independent groups; each receives every event
     * exactly once).
     */
    OUTBOX_CONSUMER_GROUP: NonEmptySchema.default('worker-search-indexer'),
    /**
     * Per-pod consumer name inside the group. Concurrent pods MUST use
     * distinct names so Redis tracks each pod's pending entries.
     * Production wires this to `process.env.HOSTNAME` (the pod name) at
     * the deployment-manifest level; the default below is for
     * single-pod dev.
     */
    OUTBOX_CONSUMER_NAME: NonEmptySchema.default('default'),
    /** Stream-name prefix — must match the relay's `STREAM_NAME_PREFIX`. */
    OUTBOX_STREAM_PREFIX: NonEmptySchema.default('events'),
    /** Max redeliveries before dead-letter. */
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /** `XREADGROUP BLOCK` argument in ms. */
    OUTBOX_POLL_BLOCK_MS: z.coerce.number().int().nonnegative().default(5_000),
    /** `XAUTOCLAIM` idle threshold in ms (crashed-pod recovery). */
    OUTBOX_RECLAIM_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
    /** Gap between polls when BLOCK returns empty. */
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),

    // ───────────────────────────────────────────────────────────────────
    // service-provider HTTP client — fetches the discovery snapshot.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Base URL of service-provider (e.g.
     * `http://service-provider.platform-services.svc.cluster.local`).
     * No trailing slash.
     */
    PROVIDER_SERVICE_BASE_URL: z.string().url('PROVIDER_SERVICE_BASE_URL must be a valid URL'),
    /**
     * Shared-secret header value the worker presents on the
     * `GET /api/v1/internal/providers/:id/discovery-snapshot` call.
     * Must match service-provider's
     * `PROVIDER_DISCOVERY_INTERNAL_API_KEY`. Minimum length 32 to
     * ensure entropy.
     */
    PROVIDER_DISCOVERY_INTERNAL_API_KEY: z
      .string()
      .min(32, 'PROVIDER_DISCOVERY_INTERNAL_API_KEY must be at least 32 characters'),
    /**
     * Header name carrying the shared secret. Must match service-
     * provider's `PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME`. Default
     * matches the receiver's default.
     */
    PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME: NonEmptySchema.default(
      'x-provider-discovery-internal-api-key',
    ),
    /** Outbound HTTP timeout for the snapshot call (ms). */
    PROVIDER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),

    // ───────────────────────────────────────────────────────────────────
    // service-search HTTP client — PUTs the upserted doc.
    // ───────────────────────────────────────────────────────────────────

    /** Base URL of service-search. */
    SEARCH_SERVICE_BASE_URL: z.string().url('SEARCH_SERVICE_BASE_URL must be a valid URL'),
    /**
     * Shared-secret header value the worker presents on the
     * `PUT /api/v1/internal/search/providers/:id` call. Must match
     * service-search's `SEARCH_INDEX_API_KEY`. Minimum length 32.
     */
    SEARCH_INDEX_API_KEY: z.string().min(32, 'SEARCH_INDEX_API_KEY must be at least 32 characters'),
    /**
     * Header name carrying the shared secret. Must match service-
     * search's `SEARCH_INDEX_HEADER_NAME`. Default matches the
     * receiver's default.
     */
    SEARCH_INDEX_HEADER_NAME: NonEmptySchema.default('x-internal-api-key'),
    /** Outbound HTTP timeout for the upsert call (ms). */
    SEARCH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
    /**
     * Observability knobs (TS-504-followup-2a-2; PDD §20.5, CLAUDE.md §10).
     * Consumed by `src/observability/bootstrap.ts`, which reads them straight
     * from `process.env` before `loadEnv` runs. RE-DECLARED here because this
     * schema is `.strict()` and TS-153's key-pick drops undeclared keys — a
     * ConfigMap that sets a key nothing declares configures nothing while
     * looking like configuration (the defect TS-306-followup-1c found).
     */
    OTEL_TRACES_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    OTEL_METRICS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .string()
      .url('OTEL_EXPORTER_OTLP_ENDPOINT must be a valid URL')
      .optional(),
    /**
     * Sentry DSN (CLAUDE.md §10). Optional, and its ABSENCE is the off switch;
     * an EMPTY value means "declared, off", which is the state `.env.example`
     * expresses and which `initSentry` already treats as absent.
     */
    SENTRY_DSN: z.string().url('SENTRY_DSN must be a valid URL').or(z.literal('')).optional(),
  })
  .strict();

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`worker-search-indexer env validation failed: ${EnvValidationError.format(issues)}`);
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
