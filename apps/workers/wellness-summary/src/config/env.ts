import { z } from 'zod';

/**
 * Environment-variable schema for worker-wellness-summary (TS-235).
 *
 * Validated once at bootstrap; failure aborts the process with a
 * structured error rather than starting unhealthy (CLAUDE.md §17.11).
 *
 * The worker is a cross-service aggregator with NO datastore of its own.
 * It needs four base URLs + four shared secrets — one per internal hop:
 *   - service-household  households batch
 *   - service-identity   recipient-contacts batch
 *   - service-booking    observation summary
 *   - service-notification dispatch
 * plus the monthly-cadence knobs the scheduler reads.
 */

const NonEmptySchema = z.string().min(1);
const SharedSecretSchema = (name: string): z.ZodString =>
  z.string().min(32, `${name} must be at least 32 characters`);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3052` — next free in the worker block above the
     * service ports (outbox-relay=3050, search-indexer=3051). Used only
     * by `/healthz` + `/readyz`; the work runs on a polling timer.
     */
    PORT: z.coerce.number().int().positive().default(3056),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SERVICE_VERSION: z.string().default('dev'),

    // ── service-household: households batch ──────────────────────────
    HOUSEHOLD_SERVICE_BASE_URL: z.string().url('HOUSEHOLD_SERVICE_BASE_URL must be a valid URL'),
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: SharedSecretSchema(
      'HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY',
    ),
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: NonEmptySchema.default('x-internal-api-key'),

    // ── service-identity: recipient-contacts batch ───────────────────
    IDENTITY_SERVICE_BASE_URL: z.string().url('IDENTITY_SERVICE_BASE_URL must be a valid URL'),
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: SharedSecretSchema('IDENTITY_RECIPIENT_CONTACTS_API_KEY'),
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: NonEmptySchema.default('x-internal-api-key'),

    // ── service-booking: observation summary ─────────────────────────
    BOOKING_SERVICE_BASE_URL: z.string().url('BOOKING_SERVICE_BASE_URL must be a valid URL'),
    BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: SharedSecretSchema(
      'BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY',
    ),
    BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: NonEmptySchema.default('x-internal-api-key'),

    // ── service-notification: dispatch ───────────────────────────────
    NOTIFICATION_SERVICE_BASE_URL: z
      .string()
      .url('NOTIFICATION_SERVICE_BASE_URL must be a valid URL'),
    NOTIFICATION_DISPATCH_API_KEY: SharedSecretSchema('NOTIFICATION_DISPATCH_API_KEY'),
    NOTIFICATION_DISPATCH_HEADER_NAME: NonEmptySchema.default('x-internal-api-key'),

    /** Per-request timeout for every outbound internal call. Default 10s. */
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),

    /**
     * Kill-switch (CLAUDE.md §11 feature flags). When `false` the
     * scheduler stays armed but every tick is a no-op — lets ops disable
     * the monthly send without redeploying. String env → boolean.
     */
    WELLNESS_SUMMARY_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /** Observation look-back window. 30 or 90 (matches the trend contract). */
    WELLNESS_SUMMARY_WINDOW_DAYS: z.coerce
      .number()
      .int()
      .refine((v) => v === 30 || v === 90, 'WELLNESS_SUMMARY_WINDOW_DAYS must be 30 or 90')
      .default(30),

    /**
     * Day-of-month (UTC) the monthly batch fires on. Capped at 28 so it
     * exists in every month. Default 1 (run on the 1st, reporting the
     * prior month).
     */
    WELLNESS_SUMMARY_RUN_DAY_OF_MONTH: z.coerce.number().int().min(1).max(28).default(1),

    /** Hour-of-day (UTC) the batch is allowed to start. Default 13:00 UTC. */
    WELLNESS_SUMMARY_RUN_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(13),

    /**
     * How often the scheduler wakes to check whether it's time to run.
     * Default 1h — fine-grained enough to catch the configured hour, coarse
     * enough to be cheap. The in-process last-run guard + the deterministic
     * dispatch idempotency keys make a missed/duplicate tick harmless.
     */
    WELLNESS_SUMMARY_SCHEDULER_TICK_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .default(3_600_000),

    /** Households fetched per batch page. Default 100, max 500. */
    WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT: z.coerce.number().int().positive().max(500).default(100),

    /** Product name rendered in the email footer. */
    WELLNESS_SUMMARY_APP_NAME: NonEmptySchema.default('Taste & See'),
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
    super(`worker-wellness-summary env validation failed: ${EnvValidationError.format(issues)}`);
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
