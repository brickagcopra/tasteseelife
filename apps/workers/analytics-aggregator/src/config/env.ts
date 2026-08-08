import { z } from 'zod';

/**
 * Environment-variable schema for worker-analytics-aggregator (TS-217-prep-3b).
 *
 * Validated once at bootstrap; failure aborts the process with a structured
 * error rather than starting unhealthy (CLAUDE.md §17.11).
 *
 * The worker is a thin scheduled trigger with NO datastore of its own. It
 * makes one shared-secret-pinned internal call per day to service-analytics'
 * `POST /api/v1/internal/analytics/search-relevance/compute`, which owns the
 * raw-table read + the aggregation. The worker therefore needs one base URL +
 * one shared secret + the nightly-cadence knobs.
 *
 * The shared secret matches service-analytics' `INTERNAL_AGGREGATION_API_KEY`
 * — rotation is a two-side deploy.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3054` — next free in the worker block (outbox-relay 3050,
     * identity-janitor 3051, wellness-summary 3052, accounting-metrics 3053).
     * Used only by the `/healthz` + `/readyz` probes; the work runs on a
     * polling timer.
     */
    PORT: z.coerce.number().int().positive().default(3054),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SERVICE_VERSION: z.string().default('dev'),

    /** Base URL of service-analytics (e.g. http://service-analytics:3023). */
    ANALYTICS_SERVICE_BASE_URL: z.string().url('ANALYTICS_SERVICE_BASE_URL must be a valid URL'),
    /**
     * Shared secret pinning the internal compute endpoint. Same value as
     * service-analytics' `INTERNAL_AGGREGATION_API_KEY`.
     */
    ANALYTICS_AGGREGATION_INTERNAL_API_KEY: z
      .string()
      .min(32, 'ANALYTICS_AGGREGATION_INTERNAL_API_KEY must be at least 32 characters'),
    /** Header carrying the shared secret. Matches the analytics controller. */
    ANALYTICS_AGGREGATION_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-analytics-internal-api-key'),

    /** Per-request timeout for the outbound compute call. Default 30s. */
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(30_000),

    /**
     * Kill-switch (CLAUDE.md §11 feature flags). When `false` the scheduler
     * stays armed but every tick is a no-op — lets ops disable the nightly
     * aggregation without redeploying. String env → boolean.
     */
    ANALYTICS_AGGREGATOR_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /**
     * Hour-of-day (UTC) the nightly aggregation is allowed to fire. Default
     * 03:00 UTC — after midnight has closed the PREVIOUS UTC day (the day this
     * run aggregates) and after the 02:00 accounting-metrics sweep, to keep
     * the nightly job fleet staggered.
     */
    ANALYTICS_AGGREGATOR_RUN_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(3),

    /**
     * How often the scheduler wakes to check whether it's time to run.
     * Default 1h — coarse enough to be cheap, fine enough to catch the
     * configured hour. The in-process last-run-day guard + the idempotent
     * (date-keyed) compute make a missed/duplicate tick harmless.
     */
    ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .default(3_600_000),
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
    super(
      `worker-analytics-aggregator env validation failed: ${EnvValidationError.format(issues)}`,
    );
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
