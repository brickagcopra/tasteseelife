import { z } from 'zod';

/**
 * Environment-variable schema for service-notification.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with TS-072:
 *
 *   - Skeleton — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION`.
 *
 *   - Admin authentication — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *     `JWT_AUDIENCE`. service-notification verifies access tokens minted
 *     by service-identity for the admin template CRUD endpoints.
 *     Mirrors the service-audit / service-booking / service-provider
 *     env contract.
 *
 *   - Internal-render shared secret — `NOTIFICATION_RENDER_HEADER_NAME`
 *     / `NOTIFICATION_RENDER_API_KEY`. Every cross-service caller (e.g.
 *     service-notification's own channel dispatchers in TS-073, plus
 *     any upstream that wants a pre-rendered preview) POSTs to
 *     `/api/v1/internal/notification/render` with this header. The
 *     TS-151 NetworkPolicy will restrict the route to in-cluster
 *     callers; the header is the application-layer defence-in-depth.
 *     Mirrors `AUDIT_INGEST_API_KEY` / `BOOKING_TIER_DISPATCH_API_KEY`
 *     shape.
 *
 * Redis is NOT pulled in at TS-072 — the admin CRUD endpoints are
 * naturally idempotent via the `(code, locale)` UNIQUE constraint; the
 * render endpoint is read-only. The Idempotency-Key HTTP-header surface
 * lands when TS-073 channel dispatchers introduce dispatch dedup.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3017`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking = 3015, audit = 3016. service-notification gets the
     * next-available so the local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3028),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-072 — JWT access-token verification. service-notification
    // consumes JWTs minted by service-identity (TS-022) for the admin
    // template CRUD endpoints.
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
     * Pinned issuer claim — must match service-identity's `JWT_ISSUER`.
     */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /**
     * Pinned audience claim — same default as service-identity's
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
    // TS-072 — Internal-render shared secret. Every cross-service caller
    // POSTs to `/api/v1/internal/notification/render` with this header.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Header carrying the shared secret. Lowercase by convention so
     * the `request.header(...)` call is case-stable. Default mirrors
     * the established `x-internal-api-key` shape.
     */
    NOTIFICATION_RENDER_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    /**
     * Shared-secret value compared against
     * `NOTIFICATION_RENDER_HEADER_NAME`. Must be at least 32 characters;
     * never logged. Rotated via the standard secrets-manager flow
     * (CLAUDE.md §3.5).
     */
    NOTIFICATION_RENDER_API_KEY: z
      .string()
      .min(32, 'NOTIFICATION_RENDER_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-073 — Dispatch endpoint shared secret. Every upstream caller
    // (booking, subscription, identity, ...) POSTs to
    // `/api/v1/internal/notification/dispatch` with this header.
    // ───────────────────────────────────────────────────────────────────

    NOTIFICATION_DISPATCH_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    NOTIFICATION_DISPATCH_API_KEY: z
      .string()
      .min(32, 'NOTIFICATION_DISPATCH_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-073 — Channel SDK configuration. Each cluster is OPTIONAL —
    // missing credentials cause the relevant adapter to fall back to
    // "stub mode" (the would-have-been-sent payload is logged + the row
    // is marked `sent` with a deterministic `stub-${id}` provider id).
    // Stub mode is the dev / CI default; production injects real keys.
    // ───────────────────────────────────────────────────────────────────

    /** Postmark server token. Missing → stub mode for email. */
    POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
    /** Verified Postmark "From" address (deliverability gate). */
    NOTIFICATION_EMAIL_FROM_ADDRESS: z
      .string()
      .email('NOTIFICATION_EMAIL_FROM_ADDRESS must be a valid email')
      .default('no-reply@tasteandsee.example.com'),
    NOTIFICATION_EMAIL_FROM_NAME: z.string().min(1).default('Taste & See'),

    /** Twilio Account SID + Auth Token. Either missing → stub mode for SMS. */
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    /** Twilio "From" — E.164 phone number or Messaging Service SID. */
    NOTIFICATION_SMS_FROM_NUMBER: z.string().min(1).optional(),

    /**
     * Firebase service-account JSON, base64-encoded. Missing → stub mode
     * for push. We accept base64 rather than a path so the secret can
     * round-trip a secrets manager without filesystem touch.
     */
    FIREBASE_SERVICE_ACCOUNT_B64: z.string().min(1).optional(),
    FIREBASE_PROJECT_ID: z.string().min(1).optional(),
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

    // ───────────────────────────────────────────────────────────────────
    // TS-042-followup-3a2 — the dunning ladder. service-notification's
    // FIRST consumer surface: until now it only ever acted when something
    // called it. Redis was deliberately absent from this service (the
    // header comment above says so); it arrives here because the outbox
    // consumer SDK reads Redis Streams.
    // ───────────────────────────────────────────────────────────────────

    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),

    /**
     * Consumer name within the `service-notification` group — the Redis
     * Streams consumer identity. MUST be distinct per replica so
     * `XAUTOCLAIM` can tell a crashed pod's pending entries from a live
     * pod's; two replicas sharing a name corrupt the PEL. Deployments set it
     * from the pod name via the downward API.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Stream prefix, which MUST match the relay's `STREAM_NAME_PREFIX`.
     * Override both ends together or this service silently reads an empty
     * stream forever — which here means families are never told their
     * payment failed, with every dashboard still green.
     */
    OUTBOX_STREAM_PREFIX: z.string().min(1).default('events'),
    /** Redeliveries before a row dead-letters. */
    OUTBOX_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /** `XREADGROUP BLOCK` argument (ms). */
    OUTBOX_CONSUMER_POLL_BLOCK_MS: z.coerce.number().int().nonnegative().default(5_000),
    /** `XAUTOCLAIM` idle threshold (ms) before a crashed pod's entries reclaim. */
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
    /** Gap between scheduler ticks when BLOCK returns empty (ms). */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),

    /**
     * Kill switch for the dunning ladder. `false` registers no handlers at
     * all — the consumer still runs for any other event, but no billing
     * email is sent. A real operational lever: if the ladder starts mailing
     * families it should not, ops flips this rather than redeploying.
     *
     * NOT `z.coerce.boolean()` — that is `Boolean(value)`, under which the
     * string "false" is TRUE and the switch is unflippable from an env var.
     */
    DUNNING_NOTIFICATIONS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((value) => (typeof value === 'boolean' ? value : value.toLowerCase() !== 'false')),

    /** service-household — resolves a household id to its active payers. */
    HOUSEHOLD_SERVICE_BASE_URL: z.string().url('HOUSEHOLD_SERVICE_BASE_URL must be a valid URL'),
    /**
     * Header name the shared secret rides on for service-household's
     * `/api/v1/internal/users/:userId/household-memberships` route.
     *
     * **The default must match what service-household READS**, which is
     * `x-household-memberships-internal-api-key` — the reader is
     * authoritative, and the api-gateway (the other caller of this same
     * endpoint) already agrees. It defaulted to the generic
     * `x-internal-api-key` here, so any environment relying on defaults
     * sent a header the callee never looks at and every dunning-recipient
     * resolution 401'd — a failure that reads as a rotated secret rather
     * than a name mismatch. The k8s manifest sets the correct value
     * explicitly, so this was latent in deployed clusters and live
     * everywhere else. `packages/testing`'s cross-app header agreement
     * guard is what caught it.
     */
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-household-memberships-internal-api-key'),
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: z
      .string()
      .min(32, 'HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY must be at least 32 characters'),

    /**
     * service-provider — resolves a provider id to its owning account
     * (TS-042-followup-3a1a). The `provider` customer-group twin of the
     * household hop above; without it a provider whose card failed was
     * counted as `skipped_customer_group` and told nothing.
     *
     * The header default must match what service-provider READS — the
     * reader is authoritative. That rule is not a style preference here: a
     * mismatch 401s every provider dunning resolution and reads as a
     * rotated secret rather than a name mismatch. `packages/testing`'s
     * cross-app header agreement guard is what enforces it.
     */
    PROVIDER_SERVICE_BASE_URL: z.string().url('PROVIDER_SERVICE_BASE_URL must be a valid URL'),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-provider-billing-contacts-internal-api-key'),
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: z
      .string()
      .min(32, 'PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY must be at least 32 characters'),

    /** service-identity — resolves those payer userIds to email addresses. */
    IDENTITY_SERVICE_BASE_URL: z.string().url('IDENTITY_SERVICE_BASE_URL must be a valid URL'),
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: z
      .string()
      .min(32, 'IDENTITY_RECIPIENT_CONTACTS_API_KEY must be at least 32 characters'),

    /**
     * The `billingUrl` every dunning template renders. Points at the family
     * billing surface that EXISTS — a read-only invoices page. There is no
     * family manages billing — web-family `/billing`, which opens a Stripe
     * Billing Portal session (TS-042-followup-3a3-followup-1). It pointed
     * at the read-only invoice list until that shipped, which is why the
     * copy said "review your billing details" and never "update your
     * card"; both changed together, and a test now REQUIRES the
     * card-update phrasing. **Must match service-subscription's
     * `BILLING_PORTAL_RETURN_URL`** — that is where Stripe drops the
     * family coming back.
     */
    DUNNING_BILLING_URL: z.string().url('DUNNING_BILLING_URL must be a valid URL'),
    /** The `appName` every template renders. */
    DUNNING_APP_NAME: z.string().min(1).default('Taste & See'),

    // ───────────────────────────────────────────────────────────────────
    // Account email verification (TS-510-followup-4).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Base URL of the page that confirms a verification token. The
     * consumer appends `?token=<token>` and the result is what the email
     * links to.
     *
     * **Config, not payload.** The event carries the token and nothing
     * about where to send the reader; if a producer could name the
     * destination, an attacker who could forge an event could point a real
     * verification link at their own host. It is the same reason
     * service-subscription's `BILLING_PORTAL_RETURN_URL` is config.
     *
     * Defaults to the local portal so a developer signup mails a link that
     * works. There is no sensible production default, but a required field
     * would take the whole service down over a message it may never be
     * asked to send — `EMAIL_VERIFICATION_ENABLED` is the honest lever for
     * "we are not sending these yet".
     */
    EMAIL_VERIFICATION_URL_BASE: z
      .string()
      .url('EMAIL_VERIFICATION_URL_BASE must be a valid absolute URL')
      .default('http://localhost:3000/verify-email'),

    /**
     * Kill switch for the verification-email consumer. Same shape and same
     * reason as `DUNNING_NOTIFICATIONS_ENABLED`: when false the handler is
     * NOT REGISTERED, so events stay in the stream and turning it back on
     * recovers them. A handler that acked and did nothing would consume
     * them permanently — and here that means a batch of new customers who
     * silently never got their link.
     *
     * NOT `z.coerce.boolean()` — that is `Boolean(value)`, under which the
     * string "false" is TRUE and the switch is unflippable from an env var.
     */
    EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((value) => (typeof value === 'boolean' ? value : value.toLowerCase() !== 'false')),
  })
  .strict();

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`service-notification env validation failed: ${EnvValidationError.format(issues)}`);
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
