import { z } from 'zod';

/**
 * Environment-variable schema for worker-certification-renewal (TS-256).
 *
 * Validated once at bootstrap; failure aborts the process with a
 * structured error rather than starting unhealthy (CLAUDE.md §17.11).
 *
 * The worker is a cross-service aggregator with NO datastore of its own.
 * It needs three base URLs + three shared secrets — one per internal hop:
 *   - service-academy      renewals batch + lapse `expire` write
 *   - service-identity     recipient-contacts batch (REUSED from TS-235)
 *   - service-notification dispatch (REUSED from TS-073)
 * plus the daily-cadence knobs the scheduler reads.
 */

const NonEmptySchema = z.string().min(1);
const SharedSecretSchema = (name: string): z.ZodString =>
  z.string().min(32, `${name} must be at least 32 characters`);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3053` — next free in the worker block above the
     * service ports (outbox-relay=3050, search-indexer=3051,
     * wellness-summary=3052). Used only by `/healthz` + `/readyz`; the
     * work runs on a polling timer.
     */
    PORT: z.coerce.number().int().positive().default(3057),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SERVICE_VERSION: z.string().default('dev'),

    // ── service-academy: renewals batch + expire ─────────────────────
    ACADEMY_SERVICE_BASE_URL: z.string().url('ACADEMY_SERVICE_BASE_URL must be a valid URL'),
    ACADEMY_CERTIFICATION_RENEWALS_API_KEY: SharedSecretSchema(
      'ACADEMY_CERTIFICATION_RENEWALS_API_KEY',
    ),
    ACADEMY_CERTIFICATION_RENEWALS_HEADER_NAME: NonEmptySchema.default('x-internal-api-key'),

    // ── service-identity: recipient-contacts batch (REUSED) ──────────
    IDENTITY_SERVICE_BASE_URL: z.string().url('IDENTITY_SERVICE_BASE_URL must be a valid URL'),
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: SharedSecretSchema('IDENTITY_RECIPIENT_CONTACTS_API_KEY'),
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: NonEmptySchema.default('x-internal-api-key'),

    // ── service-notification: dispatch (REUSED) ──────────────────────
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
     * the daily run without redeploying. String env → boolean.
     */
    CERTIFICATION_RENEWAL_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),

    /** Hour-of-day (UTC) the daily batch is allowed to start. Default 14:00 UTC. */
    CERTIFICATION_RENEWAL_RUN_HOUR_UTC: z.coerce.number().int().min(0).max(23).default(14),

    /**
     * How often the scheduler wakes to check whether it's time to run.
     * Default 1h — fine-grained enough to catch the configured hour, coarse
     * enough to be cheap. The in-process last-run guard + the deterministic
     * dispatch idempotency keys make a missed/duplicate tick harmless.
     */
    CERTIFICATION_RENEWAL_SCHEDULER_TICK_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400_000)
      .default(3_600_000),

    /** Certifications fetched per batch page. Default 100, max 500. */
    CERTIFICATION_RENEWAL_PAGE_LIMIT: z.coerce.number().int().positive().max(500).default(100),

    /**
     * Forward scan horizon (days). The service returns lapsed
     * certifications plus those expiring within this many days. Default 90
     * (the largest reminder milestone); a larger value just widens the
     * harmless early-page scan. Max 366.
     */
    CERTIFICATION_RENEWAL_HORIZON_DAYS: z.coerce.number().int().positive().max(366).default(90),

    /**
     * The renew / continuing-education URL rendered as the email CTA. A
     * deployment-specific origin (CLAUDE.md §17.11); default is the
     * example academy renewals page so dev/test render a recognisable,
     * non-routable link.
     */
    CERTIFICATION_RENEWAL_RENEW_URL: z
      .string()
      .url('CERTIFICATION_RENEWAL_RENEW_URL must be a valid URL')
      .default('https://academy.tasteandsee.example.com/renewals'),

    /** Product name rendered in the email. */
    CERTIFICATION_RENEWAL_APP_NAME: NonEmptySchema.default('Taste & See'),
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
      `worker-certification-renewal env validation failed: ${EnvValidationError.format(issues)}`,
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
