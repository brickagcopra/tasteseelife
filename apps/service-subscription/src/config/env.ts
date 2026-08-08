import { z } from 'zod';

/**
 * Environment-variable schema for service-subscription.
 *
 * Validated once at bootstrap. Failure aborts the process with a structured
 * error rather than silently falling back to defaults — fail-fast keeps
 * misconfigured deployments out of the request path (CLAUDE.md §17.11:
 * never hardcode environment-dependent values).
 *
 * Layered surface:
 *   1. **Skeleton** (TS-040) — DATABASE_URL + standard NODE_ENV/PORT/etc.
 *      Powers the read-only plan-catalog endpoint.
 *   2. **Stripe outbound** (TS-041b) — STRIPE_SECRET_KEY + optional
 *      STRIPE_API_VERSION. Required from the first request because the
 *      subscription create/patch/cancel endpoints are useless without
 *      them; refusing to start makes the misconfiguration obvious.
 *   3. **Access-token verification** (TS-041b) — JWT_ACCESS_SECRET +
 *      audience/issuer pins. Mirrors the contract used by service-identity
 *      (issuer) and service-household (verifier).
 *
 * Stripe webhook handling lives in `service-webhook` (TS-041a), not here.
 * The inbound STRIPE_WEBHOOK_SECRET is intentionally absent from this
 * service's env — once TS-142 routes verified events back via the relay,
 * the consumer code will read from the relay topic, not from a webhook
 * directly.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3012`: identity = 3010, household = 3011. New services
     * pick the next-available port to keep the local dev runbook
     * predictable (`pnpm infra:up` + `pnpm -F <svc> start` and the URL
     * is `localhost:30NN`).
     */
    PORT: z.coerce.number().int().positive().default(3012),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Stripe outbound (TS-041b). The secret key authenticates the
    // outbound POST to https://api.stripe.com/v1/...; lifecycles are
    // independent of the webhook signing secret in service-webhook.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Stripe secret API key (`sk_test_...` or `sk_live_...`). Sourced
     * from secrets manager in deployed environments; from the developer
     * dashboard for local. Never logged — the Stripe client logs already
     * redact, and our service code paths log Stripe ids only.
     *
     * The min-length floor (`16`) catches obvious typo/empty-string
     * mishaps without hard-coding the precise prefix (Stripe has used
     * `sk_test_`, `sk_live_`, `rk_test_` for restricted keys; they all
     * exceed 16 chars).
     */
    STRIPE_SECRET_KEY: z
      .string()
      .min(16, 'STRIPE_SECRET_KEY must be at least 16 characters (Stripe sk_... format)'),
    /**
     * Stripe API version pin. Optional — when absent, the SDK uses the
     * version baked into the SDK release. Pinning is the safer choice
     * because it makes the request shape deterministic across SDK
     * upgrades (a major-version SDK bump would otherwise silently shift
     * the response type the service is asserting against).
     */
    STRIPE_API_VERSION: z.string().min(1).optional(),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification (TS-041b). service-subscription consumes
    // JWTs minted by service-identity. Same HS256-shared-secret contract
    // as service-household; flips to RS256 with TS-022-followup-2 once a
    // second verifier (gateway-api, TS-140) exists.
    // ───────────────────────────────────────────────────────────────────

    /**
     * HS256 verification secret for access tokens issued by
     * service-identity. Same value as service-identity's
     * `JWT_ACCESS_SECRET` — sharing a symmetric secret across the
     * issuer and verifier is the Phase 1 contract.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /**
     * Pinned issuer claim — must match the `JWT_ISSUER` configured on
     * service-identity. A token issued by an unrelated service (or a
     * compromised secondary issuer) will not pass even if the secret
     * matches by accident.
     */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /**
     * Pinned audience claim. Same default as service-identity's
     * `JWT_AUDIENCE`.
     */
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
    // Idempotency cache (TS-044). Backs the @Idempotent() interceptor
    // exposed by @taste-and-see/nest-idempotency. CLAUDE.md §3.3 / §17.5.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Cluster-shared across services; per-service
     * namespacing is enforced inside the package via the
     * `{env}:{service}:idempotency:{actor}:{hashedKey}` key shape
     * (CLAUDE.md §3.7).
     *
     * The package configures the underlying ioredis client with
     * `enableOfflineQueue: false` + `maxRetriesPerRequest: 1` so a Redis
     * outage degrades the interceptor to "proceed without cache" (per
     * CLAUDE.md §4.3) rather than queuing commands and blocking the
     * request path. Until TS-150's Terraform/Helm wiring lands the local
     * dev runbook is `pnpm infra:up` (docker-compose Redis at
     * `redis://localhost:6379`).
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    // ───────────────────────────────────────────────────────────────────
    // TS-041b-followup-3a — outbox CONSUMER settings. This service reads the
    // relayed `stripe.*` billing events service-webhook produces. The Redis
    // connection is the `REDIS_URL` already configured above.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Consumer name within the `service-subscription` group — the Redis
     * Streams consumer identity. MUST be distinct per replica so
     * `XAUTOCLAIM` can tell a crashed pod's pending entries from a live
     * pod's; two replicas sharing a name corrupt the PEL. Deployments set it
     * from the pod name via the downward API; `default` suits single-replica
     * local dev.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Stream prefix, which MUST match the relay's `STREAM_NAME_PREFIX`.
     * Override both ends together or this service silently reads an empty
     * stream forever — which here means local subscription rows quietly stop
     * tracking Stripe, with every dashboard still rendering confidently.
     */
    OUTBOX_STREAM_PREFIX: z.string().min(1).default('events'),
    /**
     * Redeliveries before a row dead-letters. 10 attempts at the default 60s
     * reclaim interval gives ~10 minutes of redelivery — enough to ride out a
     * transient Postgres or Stripe-API failure without burning ops attention.
     */
    OUTBOX_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /**
     * `XREADGROUP BLOCK` argument (ms). Higher = less Redis traffic; lower =
     * faster shutdown response. 5000 mirrors the SDK + relay cadence.
     */
    OUTBOX_CONSUMER_POLL_BLOCK_MS: z.coerce.number().int().nonnegative().default(5_000),
    /**
     * `XAUTOCLAIM` idle threshold (ms). Entries pending past this become
     * eligible for reclaim from a crashed pod. 60s matches the SDK default
     * plus a typical Kubernetes pod-disruption window.
     */
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
    /**
     * Gap between scheduler ticks when BLOCK returns empty (ms). This
     * interval bounds how stale a subscription row can be after Stripe
     * changed it — a family's billing page reading `active` for a
     * subscription Stripe already moved to `past_due` — so it stays low.
     */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),

    // ───────────────────────────────────────────────────────────────────
    // TS-042-followup-2 — the dunning-exhaustion sweep. Converts `past_due`
    // subscriptions whose grace window has expired into `unpaid`. Runs
    // in-service on the shared BullMQ scheduler; the Redis connection is the
    // `REDIS_URL` already configured above.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Kill switch. `false` creates no queue and no worker at all — a real
     * operational lever, not a test affordance: if the sweep starts converting
     * subscriptions it should not, ops flips this rather than redeploying.
     *
     * NOT `z.coerce.boolean()` — that is `Boolean(value)`, under which the
     * string "false" is TRUE and the switch is unflippable from an env var.
     * Same shape as booking's `BOOKING_ANOMALY_DETECTION_ENABLED` and
     * identity's `RBAC_REVOKER_ENABLED`.
     */
    SUBSCRIPTION_DUNNING_SWEEP_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Sweep cadence in milliseconds. Default 3_600_000 (hourly), matching the
     * schedule TS-042-followup-2 specified.
     *
     * The grace window is measured in DAYS (`DUNNING_GRACE_DAYS`, default 21),
     * so an hour of latency on a 21-day deadline is immaterial — and a tighter
     * cadence would only spend more index scans discovering the same empty
     * result. The sweep is a deadline check, not a reaction.
     */
    SUBSCRIPTION_DUNNING_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),

    /**
     * TTL for cached completed responses, in seconds. Default 86400 (24h)
     * matches the CLAUDE.md §3.3 contract. Lower in tests / fixtures
     * where rotation visibility matters.
     */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /**
     * TTL for in-flight markers, in seconds. Default 60 — every endpoint
     * we cache is expected to return well under a minute. Raise this
     * when a long-running handler (e.g. an admin batch op) is moved
     * under the interceptor.
     */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(60),

    // ───────────────────────────────────────────────────────────────────
    // Dunning policy (TS-042). The DunningService stamps
    // `dunning_grace_until = first_failure_at + DUNNING_GRACE_DAYS` on
    // the first payment failure of a billing cycle. After that point
    // (read by the dunning sweeper — TS-042-followup-2), the row flips
    // from `past_due` to `unpaid`.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Grace window in days between the first failed payment in a cycle
     * and the dunning-exhausted transition. Default 21 days mirrors
     * Stripe's smart-retry schedule (which retries on days 3, 5, 7, 11,
     * 18 by default) plus a buffer for human-in-the-loop ops resolution.
     * Configurable per environment so a staging soak can compress it.
     */
    DUNNING_GRACE_DAYS: z.coerce.number().int().min(1).max(180).default(21),

    // ───────────────────────────────────────────────────────────────────
    // Stripe Billing Portal (TS-042-followup-3a3-followup-1).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Absolute URL Stripe returns the customer to when they close the
     * hosted Billing Portal.
     *
     * **Server-side on purpose.** `return_url` is a redirect target
     * wearing Stripe's branding for the duration of the trip; accepting
     * it from the request body — as the checkout flow's `successUrl` /
     * `cancelUrl` do — would make this endpoint an open redirect. There
     * is no legitimate case for a client to choose it, so it is config.
     *
     * **Keep in step with service-notification's `DUNNING_BILLING_URL`.**
     * The dunning ladder's call to action points at that URL and this is
     * where Stripe drops the family afterwards; if they diverge, a
     * family lands somewhere other than the page that sent them. They
     * are two variables in two services because CLAUDE.md §2.3 gives
     * services no shared config surface — not because they are two
     * decisions. Both are set from the same literal in
     * `infra/kubernetes/`; move them together.
     */
    BILLING_PORTAL_RETURN_URL: z
      .string()
      .url('BILLING_PORTAL_RETURN_URL must be a valid absolute URL')
      .default('http://localhost:3000/billing'),

    // ───────────────────────────────────────────────────────────────────
    // Coupon abuse rate-limit (TS-043, CLAUDE.md §12). Redis-backed
    // fixed-window counters defend `POST /api/v1/coupons/validate`
    // against brute-force probing. Two parallel buckets — per source IP
    // and per authenticated user — with independent limits because each
    // scope guards a different attack shape (IP-bucket: one attacker
    // probing many accounts; user-bucket: one compromised account
    // probing many codes).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Max coupon-validate attempts per source IP per window. Default
     * 30/minute is high enough that a legitimate family-portal session
     * (typing + correcting a code) never trips it, but low enough that
     * any automated probe hits the gate within seconds.
     */
    COUPON_RATE_LIMIT_IP_MAX_PER_WINDOW: z.coerce.number().int().min(1).max(10_000).default(30),
    /**
     * IP-bucket window length in seconds. Default 60s.
     */
    COUPON_RATE_LIMIT_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
    /**
     * Max coupon-validate attempts per authenticated user per window.
     * Default 10/minute is tight — a legitimate customer types a code
     * at most a few times per checkout; 10/minute leaves slack for
     * typos without giving brute-force probes a useful surface.
     */
    COUPON_RATE_LIMIT_USER_MAX_PER_WINDOW: z.coerce.number().int().min(1).max(10_000).default(10),
    /**
     * User-bucket window length in seconds. Default 60s.
     */
    COUPON_RATE_LIMIT_USER_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),

    // ───────────────────────────────────────────────────────────────────
    // Observability (TS-042-followup-8; PDD §20.5, CLAUDE.md §10). The OTel
    // tracing + Prometheus metrics SDKs are booted by
    // `src/observability/bootstrap.ts` (the first import in `main.ts`),
    // which reads these knobs directly from `process.env` BEFORE this schema
    // validates — the SDK has to patch `http`/`pg`/`ioredis` before any
    // module loads. They are re-declared here only so a configured pod still
    // passes the `.strict()` gate. service-subscription is the fifth
    // consumer of `@taste-and-see/tracing` (after service-identity,
    // worker-identity-janitor, service-provider, service-webhook).
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
  .strict();

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`service-subscription env validation failed: ${EnvValidationError.format(issues)}`);
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
