import { z } from 'zod';

/**
 * Environment-variable schema for worker-media-processor (TS-201).
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of production
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * The worker walks an uploaded media object through the mandatory
 * CLAUDE.md §3.4 pipeline (magic-byte → ClamAV → Sharp/transcode) and
 * reports each stage outcome to media-svc's internal scan-event ingest.
 * Phase 1 ships stub adapters by default (ADR-0002) — only the ingest
 * URL/secret + the processing caps + the kill-switch are operator-tunable
 * here; live S3/ClamAV/Sharp/ffmpeg wiring lands behind follow-ups.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3052` — sits in the worker block above the
     * identity-janitor (`3051`) and outbox-relay (`3050`). Used only by
     * the `/healthz` + `/readyz` probes + the `/metrics` scrape route;
     * the actual work runs on a polling timer.
     */
    PORT: z.coerce.number().int().positive().default(3052),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /**
     * Global kill-switch. When false, the scheduler keeps ticking but
     * every tick is a no-op — lets ops pause processing without redeploy
     * (CLAUDE.md §11 feature-flag discipline). Default on.
     */
    MEDIA_PROCESSOR_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /**
     * Drain cadence in milliseconds — how often the scheduler pulls the
     * next batch of jobs from the job source. Default 5s; min 1s so a
     * fat-fingered value can't busy-loop. (In live mode the S3-event →
     * BullMQ source — TS-201-followup-2 — makes this a backstop drain
     * rather than the primary trigger.)
     */
    MEDIA_PROCESSOR_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
    /** Max jobs processed per drain tick. Bounds per-tick wall-clock. */
    MEDIA_PROCESSOR_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(20),

    /**
     * media-svc internal scan-event ingest base URL. The worker POSTs
     * `RecordAssetEventRequest` payloads to
     * `${SCAN_EVENT_INGEST_URL}/api/v1/internal/media/scan-events`.
     * Optional so the worker boots in stub/dev mode without media-svc
     * reachable (the HTTP client logs + treats the emit as a soft failure
     * the job retry will re-attempt).
     */
    SCAN_EVENT_INGEST_URL: z
      .string()
      .url('SCAN_EVENT_INGEST_URL must be a valid URL (http://service-media:3020)')
      .optional(),
    /** Shared secret pinning the internal scan-event ingest route (InternalSharedSecretGuard). */
    SCAN_EVENT_INGEST_API_KEY: z.string().min(16).optional(),
    /** Header name media-svc's InternalSharedSecretGuard reads the secret from. */
    SCAN_EVENT_INGEST_API_KEY_HEADER: z.string().min(1).default('x-internal-api-key'),
    /** Per-request timeout (ms) on the scan-event POST. Default 5s. */
    SCAN_EVENT_INGEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),

    /**
     * Image decompression-bomb floor (CLAUDE.md §3.4 step 5 / §17.15).
     * ~6000×4000. NEVER disabled — the schema has no "off" value. The
     * live Sharp adapter (TS-110-followup-4) passes this to
     * `Sharp({ limitInputPixels })`; the stub honours it for parity.
     */
    IMAGE_MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(24_000_000),

    /**
     * Video transcode-bomb caps — the video analog of Sharp's
     * `limitInputPixels`. A provider intro is short; a source exceeding
     * either cap is rejected (→ `process_failed`) before any expensive
     * transcode begins (ADR-0002 §3).
     */
    MEDIA_VIDEO_MAX_DURATION_SECONDS: z.coerce.number().int().positive().max(86_400).default(180),
    /** Max source frame area (width × height) accepted for transcode. ~4K = 8.3M px. */
    MEDIA_VIDEO_MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(8_300_000),

    /** Optional worker identity for log lines. */
    SERVICE_VERSION: z.string().default('dev'),

    /**
     * OpenTelemetry observability knobs (ADR-0002 / TS-022-followup-3a
     * shape). The tracing/metrics SDKs are booted in
     * `src/observability/bootstrap.ts` which reads these directly from
     * `process.env` (before `loadEnv` runs, so auto-instrumentation
     * patches `http` before any module is imported). They are
     * RE-DECLARED here so this `.strict()` schema accepts them at boot
     * rather than rejecting an otherwise-valid pod, and so a typo in the
     * endpoint URL fails fast.
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
    super(`worker-media-processor env validation failed: ${EnvValidationError.format(issues)}`);
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
