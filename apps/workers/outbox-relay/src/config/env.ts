import { z } from 'zod';

/**
 * Environment-variable schema for worker-outbox-relay.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * The relay's purpose: read undispatched rows from one-or-many
 * `{schema}.outbox_events` tables and publish them onto Redis
 * Streams. Per PDD §7.3 the bus is Redis Streams in Phase 1 and Kafka
 * in Phase 3 — the relay's wire shape is configurable behind
 * `RedisStreamPublisher`.
 *
 * `OUTBOX_SOURCES` is a comma-separated list of `schema.table`
 * identifiers — e.g. `subscription.outbox_events,booking.outbox_events`.
 * Each segment must match the strict identifier regex (lowercase
 * letters, digits, underscore; not leading with a digit) because the
 * relay interpolates the schema/table into raw SQL.
 */
const IdentifierSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_]*$/, 'identifier must be [a-z_][a-z0-9_]*');

const OutboxSourceSchema = z.string().regex(/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/, {
  message: 'OUTBOX_SOURCES entry must be schema.table (lowercase identifiers only)',
});

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3050` — sits in the worker block above the
     * service ports (identity=3010..booking=3015). Used only by the
     * `/healthz` + `/readyz` HTTP endpoints; the actual work runs on
     * a polling timer.
     */
    PORT: z.coerce.number().int().positive().default(3050),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    /**
     * Comma-separated `schema.table` pairs. Whitespace tolerated and
     * trimmed. At least one source required — a relay with zero
     * sources is a misconfiguration (process would idle forever).
     */
    OUTBOX_SOURCES: z
      .string()
      .min(1, 'OUTBOX_SOURCES must list at least one schema.table pair')
      .transform((raw) =>
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      )
      .pipe(
        z
          .array(OutboxSourceSchema)
          .min(1, 'OUTBOX_SOURCES must list at least one schema.table pair'),
      ),
    /** Poll interval in milliseconds. Default 1000ms (1s). */
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    /** Max rows claimed per source per poll cycle. Default 100. */
    BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(100),
    /**
     * Max attempts before a row is dead-lettered (the relay stops
     * trying; ops surface these via metrics + an admin endpoint).
     * Default 10 — covers a 10-minute outage at the default poll
     * interval before giving up.
     */
    MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /**
     * `XADD MAXLEN ~` bound applied to each per-event-name stream.
     * Default 100_000 — at average event sizes, ~50MB per stream.
     * The `~` form means "approximate" — Redis is allowed to trim
     * efficiently. Consumers should not rely on stream retention
     * beyond this bound; durable persistence remains the producer's
     * outbox table.
     */
    STREAM_MAXLEN: z.coerce.number().int().positive().default(100_000),
    /** Optional worker identity for log lines + Redis stream entry's `producer` field. */
    SERVICE_VERSION: z.string().default('dev'),
    /**
     * Stream-name prefix applied before the event name. Default
     * `events:` — matches the catalog naming convention.
     */
    STREAM_NAME_PREFIX: IdentifierSchema.or(z.literal('events')).default('events'),
    /**
     * OpenTelemetry observability knobs (TS-142-followup-4). The
     * tracing/metrics SDKs are booted in `src/observability/bootstrap.ts`
     * which reads these directly from `process.env` (before `loadEnv`
     * runs, so auto-instrumentation patches `pg`/`ioredis`/`http` before
     * any module is imported). They are RE-DECLARED here so this
     * `.strict()` schema accepts them at boot rather than rejecting an
     * otherwise-valid pod, and so a typo in the endpoint URL fails fast.
     *
     *   - OTEL_TRACES_ENABLED  — default true; flip false to short-circuit
     *     `initTracing` (e.g. CI runs that ship no spans to a collector).
     *   - OTEL_METRICS_ENABLED — same shape for `initMetrics`. The
     *     `/metrics` scrape endpoint is wired unconditionally (returns an
     *     empty document when disabled so Prometheus doesn't alarm on a
     *     missing target).
     *   - OTEL_EXPORTER_OTLP_ENDPOINT — optional explicit OTLP/HTTP
     *     endpoint override; falls back to the standard OTEL_* env
     *     conventions then `http://localhost:4318/v1/traces`.
     */
    OTEL_TRACES_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    OTEL_METRICS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
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
    super(`worker-outbox-relay env validation failed: ${EnvValidationError.format(issues)}`);
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
 * Parsed outbox source — schema + table separated by `.`.
 * The relay queries each pair separately so per-source health and
 * latency are observable.
 */
export interface OutboxSource {
  readonly schema: string;
  readonly table: string;
}

export function parseSources(sources: readonly string[]): OutboxSource[] {
  return sources.map((source) => {
    const [schema, table] = source.split('.');
    if (schema === undefined || table === undefined) {
      throw new Error(`invalid source '${source}' — expected schema.table`);
    }
    return { schema, table };
  });
}
