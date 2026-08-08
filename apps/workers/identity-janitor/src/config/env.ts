import { z } from 'zod';

/**
 * Environment-variable schema for worker-identity-janitor.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of production
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * The janitor's purpose: periodically delete retention-aged rows from
 * the `identity` schema so two append-mostly auth tables don't grow
 * unbounded:
 *
 *   - `identity.refresh_tokens` — one row per issued session token;
 *     rotation + expiry leave dead rows behind (TS-022-followup-3).
 *   - `identity.mfa_challenges` — one row per MFA-enabled login
 *     attempt; consumed/expired challenges are never cleaned up
 *     (TS-023-followup-4).
 *
 * The table/schema/column identifiers are CODE CONSTANTS (see
 * `prune-targets.ts`) — they are NEVER sourced from env, so the raw
 * SQL the repository builds carries no injection surface. Only the
 * retention windows + enable flags are operator-tunable here.
 *
 * Why retention defaults to 30 days PAST expiry rather than 0: an
 * expired refresh-token row is still an audit artefact (it records
 * the session's IP / UA / family lineage). Deleting it the instant it
 * expires would erase a forensic trail the moment it becomes useful
 * for a "who logged in from where" investigation. 30 days past expiry
 * keeps the recent trail intact while still bounding table growth
 * (CLAUDE.md §3.6).
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3051` — sits in the worker block above the
     * outbox-relay (`3050`). Used only by the `/healthz` + `/readyz`
     * HTTP probes; the actual work runs on a polling timer.
     */
    PORT: z.coerce.number().int().positive().default(3051),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    /**
     * Global kill-switch. When false, the scheduler keeps ticking but
     * every tick is a no-op — lets ops pause pruning without redeploy
     * (CLAUDE.md §11 feature-flag discipline). Default on.
     */
    JANITOR_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * Sweep cadence in milliseconds. Default 1h (3_600_000ms) — the
     * prune is cheap (index range scan on `expires_at`) and the tables
     * tolerate an hour of growth between sweeps. Min 60s so a fat-fingered
     * value can't busy-loop the DB.
     */
    JANITOR_INTERVAL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
    /**
     * Rows deleted per `DELETE` statement. Batching keeps each
     * statement's lock footprint + WAL volume bounded so a large
     * backlog doesn't stall replication or block concurrent auth
     * writes. Default 5_000; capped at 50_000.
     */
    JANITOR_BATCH_SIZE: z.coerce.number().int().positive().max(50_000).default(5_000),
    /**
     * Safety cap on batches per target per sweep. Bounds the wall-clock
     * a single sweep can spend on one table even with a huge backlog;
     * any remainder is cleared on the next sweep. Default 1_000 → up to
     * 5M rows/target/sweep at the default batch size.
     */
    JANITOR_MAX_BATCHES_PER_SWEEP: z.coerce.number().int().positive().max(100_000).default(1_000),
    /**
     * Retention window (whole days past `expires_at`) for
     * `identity.refresh_tokens`. `0` deletes rows the instant they
     * expire. Default 30.
     */
    REFRESH_TOKEN_RETENTION_DAYS: z.coerce.number().int().min(0).max(3_650).default(30),
    /** Per-target enable flag for the refresh-token sweep. Default on. */
    REFRESH_TOKEN_PRUNE_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * Retention window (whole days past `expires_at`) for
     * `identity.mfa_challenges`. Challenges are short-lived auth
     * artefacts with less forensic value than session tokens, but the
     * 30-day default is kept symmetric for operator predictability.
     */
    MFA_CHALLENGE_RETENTION_DAYS: z.coerce.number().int().min(0).max(3_650).default(30),
    /** Per-target enable flag for the MFA-challenge sweep. Default on. */
    MFA_CHALLENGE_PRUNE_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Optional worker identity for log lines. */
    SERVICE_VERSION: z.string().default('dev'),
    /**
     * OpenTelemetry observability knobs (TS-022-followup-3a). The
     * tracing/metrics SDKs are booted in `src/observability/bootstrap.ts`
     * which reads these directly from `process.env` (before `loadEnv`
     * runs, so auto-instrumentation patches `pg`/`http` before any module
     * is imported). They are RE-DECLARED here so this `.strict()` schema
     * accepts them at boot rather than rejecting an otherwise-valid pod,
     * and so a typo in the endpoint URL fails fast.
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
    super(`worker-identity-janitor env validation failed: ${EnvValidationError.format(issues)}`);
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
