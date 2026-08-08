import { z } from 'zod';

/**
 * Environment-variable schema for service-payouts.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11).
 *
 * Clusters of env shipping with TS-090:
 *
 *   - Skeleton — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION`.
 *
 *   - Admin authentication — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *     `JWT_AUDIENCE`. service-payouts verifies access tokens minted by
 *     service-identity for the provider-self-service + admin endpoints.
 *
 *   - Stripe Connect — `STRIPE_SECRET_KEY` (optional; absent → stub
 *     mode), `STRIPE_API_VERSION` (defaults to the version we pinned in
 *     service-subscription / service-webhook), and the platform's
 *     hosted onboarding redirect base. Live SDK wiring lands as
 *     TS-090-followup-1; until then the service runs in stub mode and
 *     mints deterministic synthetic `acct_*` ids.
 *
 *   - Internal stripe-events ingest — `STRIPE_EVENTS_HEADER_NAME` /
 *     `STRIPE_EVENTS_API_KEY`. service-webhook (TS-041a) hands off
 *     `account.updated` events with this shared-secret header. The
 *     TS-151 NetworkPolicy will restrict the route to in-cluster
 *     callers; the header is application-layer defence-in-depth.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3018`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking = 3015, audit = 3016, notification = 3017. service-
     * payouts takes the next-available port so the local dev runbook
     * stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3029),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-090 — JWT access-token verification. service-payouts consumes
    // JWTs minted by service-identity for the provider-self-service +
    // admin endpoints.
    // ───────────────────────────────────────────────────────────────────

    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
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
    // TS-090 — Stripe Connect Express. The secret key is OPTIONAL; when
    // absent the service runs in stub mode (deterministic synthetic
    // `acct_*` ids and `https://stub-onboarding.*` URLs). The explicit
    // stub sentinel `sk_test_stub_*` also forces stub mode even if a
    // real key is in the environment (useful for forcing the stub path
    // in CI / staging).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Stripe secret key. Phase 1 stub-mode-friendly — absence + the
     * `sk_test_stub_*` sentinel both opt into the deterministic stub
     * generator instead of the live SDK call.
     */
    STRIPE_SECRET_KEY: z.string().min(1).optional(),

    /**
     * Stripe API version pin. Mirrors service-subscription /
     * service-webhook's pinned version. Defaults to a stable recent
     * version so a fresh install lands in a known good state.
     */
    STRIPE_API_VERSION: z.string().min(1).default('2024-12-18.acacia'),

    /**
     * Optional override of the stub-mode onboarding base URL. Useful
     * for the dev / CI stack to point at a local mock without touching
     * the service code.
     */
    STRIPE_STUB_ONBOARDING_BASE_URL: z
      .string()
      .url('STRIPE_STUB_ONBOARDING_BASE_URL must be a valid URL')
      .default('https://stub-onboarding.tasteandsee.example.com'),

    // ───────────────────────────────────────────────────────────────────
    // TS-090 — Internal stripe-events ingest shared secret. service-
    // webhook posts the down-projected `account.updated` payload here.
    // ───────────────────────────────────────────────────────────────────

    STRIPE_EVENTS_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    STRIPE_EVENTS_API_KEY: z
      .string()
      .min(32, 'STRIPE_EVENTS_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-091 — Disbursements: T+2 schedule + thresholds.
    //
    //   - `PAYOUT_HOLD_DAYS` — earliest a disbursement may be initiated
    //     after its scheduled-for date. PRD §11.3 default is T+2 (2
    //     business days; the implementation uses calendar days for
    //     simplicity in Phase 1).
    //
    //   - `PAYOUT_MIN_AMOUNT_MINOR` — the sweep won't schedule a
    //     disbursement for less than this amount. Default $1.00 (100
    //     minor units) — Stripe Transfer has a minimum, and below-floor
    //     balances accumulate to the next sweep.
    //
    //   - `PAYOUT_TRANSFERS_HEADER_NAME` / `PAYOUT_TRANSFERS_API_KEY` —
    //     shared-secret for the internal transfer-event ingest endpoint
    //     (service-webhook hands `transfer.paid` / `transfer.failed`
    //     events off here).
    //
    //   - `PAYOUT_DEFAULT_CURRENCY` — Phase 1 USD only (PRD §11.4).
    // ───────────────────────────────────────────────────────────────────

    PAYOUT_HOLD_DAYS: z.coerce.number().int().min(0).max(30).default(2),
    PAYOUT_MIN_AMOUNT_MINOR: z.coerce.number().int().positive().default(100),
    PAYOUT_DEFAULT_CURRENCY: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/, 'PAYOUT_DEFAULT_CURRENCY must be ISO 4217 (upper-case)')
      .default('USD'),
    PAYOUT_TRANSFERS_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    PAYOUT_TRANSFERS_API_KEY: z
      .string()
      .min(32, 'PAYOUT_TRANSFERS_API_KEY must be at least 32 characters'),
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
    super(`service-payouts env validation failed: ${EnvValidationError.format(issues)}`);
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
 * Stripe SDK runs in stub mode when no live secret key is supplied OR
 * the explicit stub sentinel is set. Exposed as a helper so every
 * caller (the StripeConnectService + tests + the admin tooling) reads
 * the same predicate.
 */
export function isStripeStubMode(env: Env): boolean {
  if (env.STRIPE_SECRET_KEY === undefined) return true;
  if (env.STRIPE_SECRET_KEY.startsWith('sk_test_stub_')) return true;
  return false;
}
