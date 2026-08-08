import { z } from 'zod';

/**
 * Environment-variable schema for service-provider.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-050 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (skeleton).
 *
 *   - TS-051 — adds three clusters all needed by the new
 *     `ApplicationsModule`:
 *
 *       1. **JWT verification** — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *          `JWT_AUDIENCE`. service-provider verifies access tokens
 *          minted by service-identity (HS256 in Phase 1; RS256 +
 *          public-key fanout arrives with TS-022-followup-2). Mirrors
 *          service-household's env contract.
 *
 *       2. **Idempotency cache** — `REDIS_URL` +
 *          `IDEMPOTENCY_TTL_SECONDS` + `IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS`.
 *          The `@Idempotent()` interceptor (`@taste-and-see/nest-idempotency`)
 *          backs every write endpoint here. Mirrors service-household /
 *          service-subscription.
 *
 *       3. **Checkr integration** — `CHECKR_API_KEY`,
 *          `CHECKR_API_BASE_URL`, `CHECKR_DEFAULT_PACKAGE`,
 *          `CHECKR_DEFAULT_WORK_LOCATIONS`. Plus
 *          `BACKGROUND_CHECK_PAYLOAD_ENC_KEY` /
 *          `BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION` for the at-rest
 *          cipher (independent key from every other cipher per
 *          CLAUDE.md §3.5). Plus
 *          `BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY` — the shared
 *          secret service-webhook presents when dispatching Checkr
 *          events into service-provider.
 *
 *   - TS-053 — adds `ELASTICSEARCH_*` for the search-indexer
 *     projection.
 *
 * The env contract grows additively so each follow-up's wiring slice
 * stays small and reviewable.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3014`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013. The provider service gets
     * the next-available port so the local dev runbook stays
     * predictable.
     */
    PORT: z.coerce.number().int().positive().default(3014),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-051 — JWT access-token verification. service-provider consumes
    // JWTs minted by service-identity (TS-022); the AccessTokenGuard
    // verifies the signature, audience, and issuer before any
    // authenticated handler sees the request. Phase 1 is HS256 with a
    // shared secret; Phase 2 (TS-022-followup-2) flips to RS256.
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
     * Pinned issuer claim — must match service-identity's
     * `JWT_ISSUER`.
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
    // TS-051 — Idempotency cache. Backs the `@Idempotent()` interceptor
    // from `@taste-and-see/nest-idempotency`. CLAUDE.md §3.3 / §17.5.
    // Same wiring shape as service-household / service-subscription.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Cluster-shared across services; per-service
     * namespacing is enforced inside the package via the
     * `{env}:{service}:idempotency:{actor}:{hashedKey}` key shape
     * (CLAUDE.md §3.7).
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    /**
     * TTL for cached completed responses, in seconds. Default 86400 (24h)
     * matches the CLAUDE.md §3.3 contract.
     */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /**
     * TTL for in-flight markers, in seconds. Default 60 — every
     * endpoint we cache returns well under a minute.
     */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(60),

    // ───────────────────────────────────────────────────────────────────
    // TS-305d — Outbox CONSUMER cluster. service-provider's first;
    // until now this service was producer-only. The consumer reads
    // service-booking's lifecycle events to refresh the
    // `provider_metrics` read model, and reuses the `REDIS_URL` above
    // (one connection per pod, shared with the idempotency cache).
    //
    // Every key defaults, so no environment breaks by omission — but
    // `OUTBOX_CONSUMER_NAME` MUST be set per pod in any multi-replica
    // deployment (from the downward API, as service-trust-safety does).
    // Two replicas sharing a consumer name corrupt each other's pending
    // entries list, which here means booking events acknowledged by a
    // pod that never projected them — a metrics row silently missing
    // visits, with nothing red anywhere.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Per-pod consumer name within the `service-provider` consumer
     * group. See the block comment above: the default is correct for a
     * single replica and wrong for two.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Redis stream key prefix. MUST match the relay's
     * `STREAM_NAME_PREFIX` — a mismatch is not an error anywhere, it is
     * a consumer subscribed to a stream nothing writes to, which reads
     * as "no bookings yet" for ever.
     */
    OUTBOX_STREAM_PREFIX: z.string().min(1).default('events'),
    /**
     * Delivery attempts before an event is dead-lettered. A
     * dead-lettered booking event means that booking never reaches the
     * provider's metrics.
     */
    OUTBOX_CONSUMER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    /** Blocking `XREADGROUP BLOCK` duration, in milliseconds. */
    OUTBOX_CONSUMER_POLL_BLOCK_MS: z.coerce.number().int().nonnegative().default(5_000),
    /** Idle time before another pod's pending entries may be claimed. */
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: z.coerce.number().int().nonnegative().default(60_000),
    /** Pause between poll cycles, in milliseconds. */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),

    // ───────────────────────────────────────────────────────────────────
    // TS-051 — Background-check payload encryption. AES-256-GCM
    // symmetric key, versioned. INDEPENDENT key from every other
    // cipher in the codebase (CLAUDE.md §3.5 compartmentalisation —
    // a leaked KYC or MFA cipher key must not grant the ability to
    // read background-check payloads, and vice versa).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Base64-encoded 32-byte (256-bit) symmetric key for AES-256-GCM
     * at-rest encryption of the raw Checkr event payload. Sourced
     * from secrets manager (Vault / AWS Secrets Manager) and never
     * written to source.
     *
     * Validated to decode to exactly 32 bytes — wrong-length keys
     * are a configuration bug we want to fail fast on at boot, not
     * at the first webhook event in production.
     */
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY: z
      .string()
      .min(1, 'BACKGROUND_CHECK_PAYLOAD_ENC_KEY is required')
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'BACKGROUND_CHECK_PAYLOAD_ENC_KEY must be a base64 string that decodes to exactly 32 bytes (AES-256 key)'),
    /**
     * Integer key version stored alongside each encrypted payload.
     * Forward-compatible rotation: increment on rotation, new rows
     * encrypt under the new version, and a backfill worker
     * (TS-051-followup) re-wraps legacy rows.
     */
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION: z.coerce.number().int().positive().default(1),

    // ───────────────────────────────────────────────────────────────────
    // TS-051 — Checkr REST API. service-provider calls
    // `https://api.checkr.com/v1/candidates` and `/reports` outbound;
    // service-webhook receives the corresponding webhook events.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Checkr API key — the live secret in production, the test-mode
     * secret in dev / staging. Used as the HTTP Basic-Auth username
     * (with an empty password) per the Checkr API contract.
     */
    CHECKR_API_KEY: z.string().min(20, 'CHECKR_API_KEY must be at least 20 characters'),
    /**
     * Base URL of the Checkr API. Defaults to the production host;
     * override per-environment for the staging sandbox.
     */
    CHECKR_API_BASE_URL: z
      .string()
      .url('CHECKR_API_BASE_URL must be a valid URL')
      .default('https://api.checkr.com/v1'),
    /**
     * Default Checkr package slug (e.g. `tasker_standard`). Used at
     * report-create time; the package controls which checks Checkr
     * runs. Operator-configured so changing the package contract is
     * a single env-var bump.
     */
    CHECKR_DEFAULT_PACKAGE: z
      .string()
      .min(1, 'CHECKR_DEFAULT_PACKAGE is required')
      .default('tasker_standard'),
    /**
     * Comma-separated list of US state codes used as the default
     * `work_locations` for new reports. Phase 1 lives in NY only
     * (PRD §1 — Manhattan UES launch); rolls out across the
     * platform as a comma-separated list once additional markets
     * open. The Checkr client parses on read.
     */
    CHECKR_DEFAULT_WORK_LOCATION_STATES: z
      .string()
      .min(2, 'CHECKR_DEFAULT_WORK_LOCATION_STATES is required (comma-separated US state codes)')
      .default('NY'),
    /**
     * Outbound request timeout for Checkr API calls, in
     * milliseconds. Bounded [500, 30_000]. Default 10s — Checkr's
     * create-report endpoint occasionally takes several seconds.
     */
    CHECKR_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(10_000),

    // ───────────────────────────────────────────────────────────────────
    // TS-051 — Internal cross-service dispatch. service-webhook POSTs
    // Checkr events to service-provider's internal route; the route
    // is pinned to a shared-secret header as defence-in-depth alongside
    // the TS-151 NetworkPolicy that will restrict it to in-cluster
    // callers. Mirrors TS-026's `KYC_WEBHOOK_INTERNAL_API_KEY`.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Shared-secret header value for the internal Checkr dispatch
     * endpoint. service-webhook presents this as the
     * `x-background-check-internal-api-key` header on every dispatch
     * POST; the controller rejects with 401 on missing / wrong
     * header. Minimum length 32 to ensure entropy.
     */
    BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY: z
      .string()
      .min(32, 'BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-053 — Internal provider-discovery snapshot endpoint. The
    // search-indexer worker (apps/workers/search-indexer) calls
    // `GET /api/v1/internal/providers/:providerId/discovery-snapshot`
    // whenever an upstream provider event fires (tier_changed,
    // certification_granted, certification_revoked) to fetch a fully-
    // materialised `ProviderDiscoveryDocument`. The route is pinned to
    // a shared-secret header as defence-in-depth alongside the TS-151
    // NetworkPolicy that will restrict it to in-cluster callers.
    // Mirrors the BACKGROUND_CHECK_WEBHOOK_INTERNAL_API_KEY pattern.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Shared-secret header value for the internal discovery-snapshot
     * endpoint. The search-indexer worker presents this as the
     * `x-provider-discovery-internal-api-key` header (configurable via
     * `PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME`) on every GET; the
     * controller rejects with 401 on missing / wrong header. Minimum
     * length 32 to ensure entropy.
     */
    PROVIDER_DISCOVERY_INTERNAL_API_KEY: z
      .string()
      .min(32, 'PROVIDER_DISCOVERY_INTERNAL_API_KEY must be at least 32 characters'),
    /**
     * Header name carrying the shared secret. Configurable per
     * environment so a future SAN / DNS rename doesn't force a code
     * change. Default matches the naming convention used elsewhere
     * (lowercase, dash-separated, `x-`-prefixed for clarity).
     */
    PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-provider-discovery-internal-api-key'),

    // ───────────────────────────────────────────────────────────────────
    // TS-042-followup-3a1a — Internal provider billing-contacts endpoint.
    // service-notification's dunning ladder calls
    // `POST /api/v1/internal/providers/billing-contacts` to turn a
    // provider-group subscription's `customerId` into the owning account's
    // userId, then chains into identity's `recipient-contacts` for the
    // address.
    //
    // **Its own secret rather than reusing PROVIDER_DISCOVERY_*.** A shared
    // secret is a trust principal (CLAUDE.md §3.5), and the callers differ:
    // discovery is the search-indexer worker, this is service-notification.
    // Reusing one would mean compromising the indexer also yields the hop
    // that resolves who pays. The name also has to stay honest — a key
    // called `..._DISCOVERY_...` gating a billing route is the kind of
    // drift nobody notices until it matters.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Shared-secret header value for the internal billing-contacts
     * endpoint. Minimum length 32, matching every other internal secret
     * on this service.
     */
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: z
      .string()
      .min(32, 'PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY must be at least 32 characters'),
    /** Header name carrying that secret. Configurable per environment. */
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-provider-billing-contacts-internal-api-key'),

    // ───────────────────────────────────────────────────────────────────
    // TS-206 — Google Calendar free/busy sync (ADR-0003).
    //
    // Every field is OPTIONAL. When the Google OAuth credentials / cipher
    // key / state secret are unset, the calendar-sync endpoints return
    // `503 calendar_sync_not_configured` — the same "optional secret →
    // 503" posture the gateway uses for its internal shared secrets. This
    // keeps service-provider bootable in dev / CI without Google
    // credentials and ships the feature dark behind the absence of its
    // config (CLAUDE.md §11). `CalendarSyncService.resolveConfig()`
    // collapses the optional fields into a single resolved config object
    // (or null → 503).
    //
    // Secrets (`GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`,
    // `GOOGLE_CALENDAR_OAUTH_STATE_SECRET`, `CALENDAR_TOKEN_ENC_KEY`) are
    // sourced from the secrets manager (Vault / cloud secret manager) and
    // never written to source (CLAUDE.md §3.5).
    // ───────────────────────────────────────────────────────────────────

    /** Google OAuth 2.0 client id (web application credential). */
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    /** Google OAuth 2.0 client secret. Secret — never logged. */
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    /**
     * Registered OAuth redirect URI — Google redirects the browser here
     * with `?state&code`. Must exactly match the Google Cloud console
     * authorized-redirect-URI entry. Points at the gateway's public
     * callback path (TS-206-followup-1) in deployed environments.
     */
    GOOGLE_CALENDAR_OAUTH_REDIRECT_URI: z
      .string()
      .url('GOOGLE_CALENDAR_OAUTH_REDIRECT_URI must be a valid URL')
      .optional(),
    /**
     * HMAC-SHA256 key for signing the OAuth `state` token (CSRF +
     * identity binding). ≥ 32 chars for entropy. Secret — never logged.
     */
    GOOGLE_CALENDAR_OAUTH_STATE_SECRET: z
      .string()
      .min(32, 'GOOGLE_CALENDAR_OAUTH_STATE_SECRET must be at least 32 characters')
      .optional(),
    /**
     * Where the callback 302-redirects the browser after a successful
     * (or failed) connection — the web-provider calendar settings page.
     * A `?calendar=connected` / `?calendar=error` query is appended so
     * the page can render a result banner.
     */
    GOOGLE_CALENDAR_POST_CONNECT_REDIRECT_URL: z
      .string()
      .url('GOOGLE_CALENDAR_POST_CONNECT_REDIRECT_URL must be a valid URL')
      .optional(),
    /**
     * Base64-encoded 32-byte (256-bit) AES-256-GCM key for at-rest
     * encryption of the Google refresh token. INDEPENDENT from every
     * other cipher key in the codebase (CLAUDE.md §3.5). Validated to
     * decode to exactly 32 bytes when present.
     */
    CALENDAR_TOKEN_ENC_KEY: z
      .string()
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'CALENDAR_TOKEN_ENC_KEY must be a base64 string that decodes to exactly 32 bytes (AES-256 key)')
      .optional(),
    /**
     * Integer key version stored alongside each encrypted refresh token.
     * Forward-compatible rotation: increment on rotation, new rows
     * encrypt under the new version, and a backfill worker
     * (TS-206-followup-5) re-wraps legacy rows.
     */
    CALENDAR_TOKEN_ENC_KEY_VERSION: z.coerce.number().int().positive().default(1),
    /**
     * How far ahead (days) the free/busy pull fetches. Default 14 (two
     * weeks) — matches the family-portal "available this week/next week"
     * horizon. Bounded [1, 60].
     */
    GOOGLE_CALENDAR_SYNC_WINDOW_DAYS: z.coerce.number().int().min(1).max(60).default(14),
    /**
     * TTL (seconds) for the signed OAuth `state` token. Default 600 (10
     * min) — a consent flow that takes longer than this is almost
     * certainly an abandoned / replayed link. Bounded [60, 3600].
     */
    CALENDAR_OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),

    // ───────────────────────────────────────────────────────────────────
    // Observability (TS-050-followup-1). OpenTelemetry tracing +
    // Prometheus metrics surface backed by @taste-and-see/tracing. See
    // PDD §20.5 and CLAUDE.md §10. service-provider mirrors the env shape
    // service-identity established as the FIRST real consumer of the
    // shared tracing package (TS-020-followup-1).
    //
    //   - OTEL_TRACES_ENABLED            — defaults true; flip to false
    //     to short-circuit `initTracing` (e.g. in CI runs that don't
    //     ship spans to a collector). The env is consulted at boot
    //     time, before any service module is imported.
    //   - OTEL_METRICS_ENABLED           — same shape for `initMetrics`.
    //     The /metrics scrape endpoint is wired unconditionally
    //     (returns an empty document when metrics are disabled, so
    //     Prometheus doesn't alarm on a missing target).
    //   - OTEL_EXPORTER_OTLP_ENDPOINT    — optional explicit endpoint
    //     override. Falls back to the standard env vars
    //     (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT then
    //     OTEL_EXPORTER_OTLP_ENDPOINT) then `localhost:4318/v1/traces`.
    //     We re-declare it here as `optional()` so the env validator
    //     surfaces a typo in the URL at boot rather than silently
    //     falling back.
    //
    // NOTE: `src/observability/bootstrap.ts` reads these directly from
    // `process.env` at module-load time (before Zod runs) so OTel can
    // patch `http` / `pg` / `ioredis` before any module loads. The
    // re-declaration here keeps the `.strict()` schema from rejecting a
    // configured pod and gives a typo'd endpoint a fail-fast boot error.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Enable / disable OpenTelemetry tracing initialisation. Defaults
     * true in every environment — local dev gets spans pushed to a
     * collector when one is running (and dropped silently otherwise;
     * the OTLP exporter does not block the request path on its export
     * channel). CI sets this to `false` to keep test runs deterministic.
     */
    OTEL_TRACES_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Enable / disable the Prometheus metrics surface. Defaults true.
     * The /metrics endpoint stays wired regardless — when this is
     * false, the handler returns an empty exposition document so
     * Prometheus's missing-target alert does not fire.
     */
    OTEL_METRICS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Explicit OTLP/HTTP traces endpoint. When unset the tracing
     * package falls back to the standard OTEL_* env conventions and
     * ultimately `http://localhost:4318/v1/traces`. Re-declared here
     * with `.url()` validation so a typo fails boot rather than
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
    super(`service-provider env validation failed: ${EnvValidationError.format(issues)}`);
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
