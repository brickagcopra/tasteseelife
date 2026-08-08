import { z } from 'zod';

/**
 * Environment-variable schema for service-webhook.
 *
 * Validated once at bootstrap. Failure aborts the process with a structured
 * error rather than silently falling back to defaults — fail-fast keeps
 * misconfigured deployments out of the request path (CLAUDE.md §17.11:
 * never hardcode environment-dependent values).
 *
 * Phase-1 (TS-041a) ships the signature-verified Stripe inbound endpoint, so
 * `STRIPE_WEBHOOK_SECRET` is required from the very first request. The
 * service refuses to start without it because any other shape (lenient
 * default, optional, fall-through-to-unsigned) would silently invite the
 * banned pattern CLAUDE.md §17.8 calls out: "Sending unsigned Stripe webhook
 * responses." The signing secret IS the only thing distinguishing a real
 * Stripe call from an attacker spraying our endpoint; missing it means we
 * have no security boundary at all and the right behaviour is to refuse
 * traffic, not to ack 200 to arbitrary payloads.
 *
 * Checkr / Twilio webhook secrets land alongside their respective sibling
 * tables (TS-051 / TS-073 follow-up) so the env contract grows additively
 * as each third-party integration arrives.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3013`: identity = 3010, household = 3011, subscription
     * = 3012. The webhook receiver gets the next-available port so the
     * local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3013),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),
    /**
     * Stripe webhook signing secret — `whsec_...`. Obtained from the
     * Stripe Dashboard (Developers → Webhooks → endpoint signing secret)
     * or from the local stripe-cli (`stripe listen --print-secret`).
     *
     * Required: refusing to start without it is intentional (see the
     * module doc-comment above). The verifier service consumes this on
     * every inbound request; never log it.
     *
     * Minimum length 20 to catch obvious typos / empty-string copy-paste
     * mishaps without hard-coding the full `whsec_` prefix check (Stripe
     * has used `whsec_test_` and other future-tense prefixes in
     * development environments).
     */
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .min(20, 'STRIPE_WEBHOOK_SECRET must be at least 20 characters (Stripe whsec_... format)'),
    /**
     * Stripe API version we render outbound events against. Persisted on
     * every processed event row so a future SDK upgrade can detect
     * version drift in the warehouse and bisect by event timestamp. The
     * SDK still uses its built-in default for outbound API calls
     * elsewhere in the platform; this value is for record-keeping only
     * inside webhook-svc.
     *
     * Optional — when absent, the verifier service records `null` on the
     * event row.
     */
    STRIPE_API_VERSION: z.string().min(1).optional(),
    /**
     * Replay tolerance window in seconds for Stripe signature verification.
     * Stripe signs `(timestamp, payload)` with HMAC-SHA256; the verifier
     * rejects requests whose timestamp is outside this window relative to
     * the local clock. Stripe's SDK default is 300s (5min); we expose it
     * as configurable so a slow CI / staging environment can widen the
     * window without code change.
     *
     * Lower bound is 60s (any tighter risks rejecting legitimate
     * requests due to clock skew between Stripe's edge and our pods).
     * Upper bound is 900s (15min — beyond this, replay protection
     * becomes negligible).
     */
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),

    // ───────────────────────────────────────────────────────────────────
    // TS-026 — Stripe Identity dispatch. service-webhook persists every
    // verified Stripe event under `webhook.stripe_processed_events`
    // (TS-041a); when the event is an `identity.verification_session.*`
    // event we synchronously POST it to service-identity so the
    // matching `identity.kyc_records` row gets its status hydrated. On
    // a 2xx response we stamp `dispatched_at` on the event row. On
    // failure we leave the row undispatched and the future outbox
    // relay (TS-142) takes over — this avoids a "ack-Stripe-then-fail-
    // to-deliver" silent loss.
    //
    // The dispatch is gated by the optional cluster below. When unset
    // (default) the dispatcher behaves as a no-op — useful in CI /
    // local dev where service-identity isn't necessarily running. When
    // set, both values are required together: a misconfiguration that
    // sets the URL without the API key (or vice versa) fails at boot.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Fully-qualified URL of service-identity's internal KYC dispatch
     * endpoint (`https://service-identity.../api/v1/internal/kyc/webhook-events`).
     * Optional. When absent, identity.verification_session.* events
     * still persist to `stripe_processed_events` but `dispatched_at`
     * stays null — the future TS-142 relay will pick them up. When
     * present, must be a valid URL.
     */
    KYC_DISPATCH_URL: z.string().url('KYC_DISPATCH_URL must be a valid URL').optional(),
    /**
     * Shared-secret header value service-identity's internal endpoint
     * pins. Required when `KYC_DISPATCH_URL` is set. Optional in the
     * unset path. Minimum length 32 to match service-identity's same
     * `KYC_WEBHOOK_INTERNAL_API_KEY` length floor.
     */
    KYC_DISPATCH_API_KEY: z
      .string()
      .min(32, 'KYC_DISPATCH_API_KEY must be at least 32 characters')
      .optional(),
    /**
     * Outbound request timeout for the KYC dispatch call, in
     * milliseconds. Default 5000 — service-identity's handler is
     * a small Postgres update so the realistic latency is sub-100ms;
     * 5s leaves headroom for cold-start scenarios without holding
     * the Stripe webhook ack open indefinitely.
     */
    KYC_DISPATCH_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),

    // ───────────────────────────────────────────────────────────────────
    // TS-051 — Checkr inbound webhook signature verification +
    // service-provider dispatch. service-webhook receives Checkr
    // `report.*` events at /api/v1/webhooks/checkr, persists them
    // under `webhook.checkr_processed_events`, and synchronously
    // POSTs each one to service-provider's internal route. Mirrors
    // the TS-041a + TS-026 KYC pattern.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Checkr webhook signing secret. Obtained from the Checkr
     * Dashboard (Account → Developer → Webhooks → signing secret).
     * Used by the HMAC-SHA256 verifier on every inbound Checkr
     * request.
     *
     * Required: refusing to start without it is intentional —
     * missing this secret would mean no security boundary at all,
     * and the right behaviour is to refuse traffic rather than ack
     * 200 to arbitrary payloads (same posture as
     * STRIPE_WEBHOOK_SECRET above).
     *
     * Minimum length 20 to catch obvious typos / empty-string copy-
     * paste mishaps.
     */
    CHECKR_WEBHOOK_SECRET: z
      .string()
      .min(20, 'CHECKR_WEBHOOK_SECRET must be at least 20 characters'),
    /**
     * Replay tolerance window in seconds for Checkr signature
     * verification. Checkr's signature header includes the
     * timestamp; the verifier rejects requests whose timestamp is
     * outside this window. Default 300s (5min). Bounded [60s, 900s].
     */
    CHECKR_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(60).max(900).default(300),

    /**
     * Fully-qualified URL of service-provider's internal background-
     * check dispatch endpoint. Optional. When absent, Checkr events
     * still persist to `checkr_processed_events` but `dispatched_at`
     * stays null — the future TS-142 relay will pick them up.
     */
    BACKGROUND_CHECK_DISPATCH_URL: z
      .string()
      .url('BACKGROUND_CHECK_DISPATCH_URL must be a valid URL')
      .optional(),
    /**
     * Shared-secret header value service-provider's internal
     * endpoint pins. Required when `BACKGROUND_CHECK_DISPATCH_URL`
     * is set.
     */
    BACKGROUND_CHECK_DISPATCH_API_KEY: z
      .string()
      .min(32, 'BACKGROUND_CHECK_DISPATCH_API_KEY must be at least 32 characters')
      .optional(),
    /**
     * Outbound request timeout for the background-check dispatch
     * call. Same shape as `KYC_DISPATCH_TIMEOUT_MS`.
     */
    BACKGROUND_CHECK_DISPATCH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30_000)
      .default(5_000),

    // ───────────────────────────────────────────────────────────────────
    // TS-041a-followup-4 — observability. The OTel tracing + metrics SDK
    // is booted in `src/observability/bootstrap.ts` (imported as the
    // first line of `main.ts`, reading these knobs DIRECTLY from
    // `process.env` before Zod runs). We re-declare them in the validated
    // schema too so a configured pod surfaces a typo at boot rather than
    // silently falling back, and so the `.strict()` schema does not
    // reject a pod that legitimately sets them. service-webhook mirrors
    // the env shape service-identity established as the FIRST real
    // consumer of the shared tracing package (TS-020-followup-1) and
    // service-provider as the third (TS-050-followup-1). PDD §20.5,
    // CLAUDE.md §10.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Toggle OTel tracing init. Defaults true; flip to false to
     * short-circuit `initTracing` (e.g. CI runs that don't ship spans to
     * a collector). Consulted at boot, before any service module loads.
     */
    OTEL_TRACES_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Toggle OTel metrics init. Same coercion shape as
     * `OTEL_TRACES_ENABLED`. The /metrics scrape endpoint stays wired
     * regardless — when false the handler returns an empty exposition
     * document so Prometheus's missing-target alert does not fire.
     */
    OTEL_METRICS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Optional explicit OTLP exporter endpoint override. When unset the
     * tracing package falls back to the standard
     * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT`
     * env vars and ultimately `http://localhost:4318/v1/traces`.
     * Re-declared here with `.url()` so a typo fails boot rather than
     * surfacing as a late-running silent exporter error.
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
  .strict()
  .superRefine((env, ctx) => {
    // Both halves of the KYC dispatch config must be set together,
    // or both absent.
    const hasKycUrl = env.KYC_DISPATCH_URL !== undefined;
    const hasKycKey = env.KYC_DISPATCH_API_KEY !== undefined;
    if (hasKycUrl !== hasKycKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'KYC_DISPATCH_URL and KYC_DISPATCH_API_KEY must be set together (both present, or both absent).',
        path: hasKycUrl ? ['KYC_DISPATCH_API_KEY'] : ['KYC_DISPATCH_URL'],
      });
    }
    // Same invariant for the background-check dispatch config.
    const hasBgUrl = env.BACKGROUND_CHECK_DISPATCH_URL !== undefined;
    const hasBgKey = env.BACKGROUND_CHECK_DISPATCH_API_KEY !== undefined;
    if (hasBgUrl !== hasBgKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'BACKGROUND_CHECK_DISPATCH_URL and BACKGROUND_CHECK_DISPATCH_API_KEY must be set together (both present, or both absent).',
        path: hasBgUrl ? ['BACKGROUND_CHECK_DISPATCH_API_KEY'] : ['BACKGROUND_CHECK_DISPATCH_URL'],
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`service-webhook env validation failed: ${EnvValidationError.format(issues)}`);
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
