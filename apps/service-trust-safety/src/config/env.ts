import { z } from 'zod';

/**
 * Environment-variable schema for service-trust-safety.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-300 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (skeleton). Only Postgres-side env at this stage
 *     because TS-300 ships the `incidents` + `outbox_events` tables +
 *     `/healthz` + `/readyz` only — there is no authenticated HTTP surface
 *     yet. This mirrors the service-content (TS-280) / service-ads (TS-270) /
 *     service-concierge (TS-221) "no dead config in the skeleton" convention.
 *
 *   - TS-301a (incident intake) — the first authenticated surface; brings
 *     the access-token-verification cluster (`JWT_ACCESS_SECRET` /
 *     `JWT_ISSUER` / `JWT_AUDIENCE`) plus the idempotency cache
 *     (`REDIS_URL` + TTLs) for the first write endpoint — mirroring the
 *     service-concierge (TS-222) shape.
 *
 *   - TS-302a (welfare escalation, consumer half) — the outbox-CONSUMER
 *     cluster (`OUTBOX_CONSUMER_NAME` / `OUTBOX_STREAM_PREFIX` /
 *     `OUTBOX_CONSUMER_MAX_ATTEMPTS` / `_POLL_BLOCK_MS` /
 *     `_RECLAIM_IDLE_MS` / `_POLL_INTERVAL_MS`), making this service a
 *     consumer as well as a producer for the first time. Same shape as
 *     service-accounting (TS-142-followup-2-followup-2).
 *
 *   - The SLA budgets (severity → deadline, see `modules/incidents/sla.ts`)
 *     are deliberately NOT env-tunable in the skeleton — they ship as an
 *     exported constant. Env-tunability arrives if/when ops needs to adjust
 *     budgets without a deploy (same no-dead-config reasoning).
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3026`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking/accounting = 3015, audit = 3016, messaging/notification = 3017,
     * activity/payouts = 3018, media = 3019, search = 3020, concierge = 3021,
     * academy = 3022, analytics = 3023, ads = 3024, content = 3025. The
     * trust-safety service gets the next-available port so the local dev
     * runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3026),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification (TS-301a). service-trust-safety consumes
    // JWTs minted by service-identity (TS-022); the AccessTokenGuard
    // verifies the signature, audience, and issuer before any
    // authenticated handler sees the request. Phase 1 is HS256 with a
    // shared secret; Phase 2 (TS-022-followup-2) flips to RS256. Same
    // contract as service-concierge / service-household.
    // ───────────────────────────────────────────────────────────────────

    /**
     * HS256 verification secret for access tokens issued by
     * service-identity. Same value as service-identity's
     * `JWT_ACCESS_SECRET` — sharing a symmetric secret across the issuer
     * and verifier is the Phase 1 contract.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /** Pinned issuer claim — must match service-identity's `JWT_ISSUER`. */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /** Pinned audience claim — must match service-identity's `JWT_AUDIENCE`. */
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
    // Idempotency cache (TS-301a). Backs the @Idempotent() interceptor
    // exposed by @taste-and-see/nest-idempotency. CLAUDE.md §3.3 / §17.5.
    // Same wiring shape as service-concierge / service-household.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Redis connection URL. Cluster-shared; per-service namespacing is
     * enforced inside the package via the
     * `{env}:{service}:idempotency:{actor}:{hashedKey}` key shape
     * (CLAUDE.md §3.7). A Redis outage degrades the interceptor to
     * "proceed without cache" (CLAUDE.md §4.3).
     */
    REDIS_URL: z.string().url('REDIS_URL must be a valid URL (redis://host:port[/db])'),
    /** TTL for cached completed responses, in seconds. Default 86400 (24h) per CLAUDE.md §3.3. */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
    /** TTL for in-flight markers, in seconds. Default 60. */
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: z.coerce.number().int().positive().default(60),

    // ───────────────────────────────────────────────────────────────────
    // Outbox CONSUMER (TS-302a). Until now this service was producer-only
    // — it appends `trust_safety.incident.created` and listens to nothing.
    // The welfare-escalation track (TS-302c/d) needs it to react to a
    // booking-side signal, so it gains the consumer cluster. Same shape and
    // defaults as service-accounting / service-analytics / service-audit;
    // the Redis connection is the one already configured above.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Consumer name within the `service-trust-safety` group — the Redis
     * Streams consumer identity. Distinct per replica so `XAUTOCLAIM` can
     * tell a crashed pod's pending entries from a live pod's. Deployments
     * set this from the pod name; `default` suits single-replica local dev.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Stream prefix, which MUST match the relay's `STREAM_NAME_PREFIX`.
     * Override both ends together or this service silently reads an empty
     * stream forever.
     */
    OUTBOX_STREAM_PREFIX: z.string().min(1).default('events'),
    /**
     * Redeliveries before a row dead-letters. 10 attempts at the default
     * 60s reclaim interval gives ~10 minutes of redelivery — enough to ride
     * out a transient Postgres failover without burning ops attention.
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
     * Gap between scheduler ticks when BLOCK returns empty (ms). Keeps the
     * consumer responsive without hammering Redis when the stream is quiet.
     */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),

    // ───────────────────────────────────────────────────────────────────
    // PagerDuty Events API v2 (TS-306; PDD §20.5). A `critical`-severity
    // incident pages the on-call supervisor. The client is the shared
    // `@taste-and-see/nest-pagerduty` package extracted in TS-302b — this
    // service is its second consumer, which is why `source` is a required
    // module option there rather than a per-service zod default.
    //
    // The routing key is OPTIONAL: unset disables paging, and the incident
    // still lands with its SLA clock running. That degradation is the same
    // posture as service-concierge (CLAUDE.md §16 — degrade gracefully); the
    // durable incident is the source of truth and the page is a notification
    // on top. The key is a secret from Vault / the cloud secret manager
    // (CLAUDE.md §3.5), never committed.
    // ───────────────────────────────────────────────────────────────────

    /**
     * PagerDuty Events API v2 routing (integration) key for the trust &
     * safety on-call rotation. Optional — unset disables paging.
     */
    PAGERDUTY_ROUTING_KEY: z.string().min(1).optional(),
    /** Events API v2 enqueue endpoint. Overridable for the EU region / a test double. */
    PAGERDUTY_EVENTS_URL: z
      .string()
      .url('PAGERDUTY_EVENTS_URL must be a valid URL')
      .default('https://events.pagerduty.com/v2/enqueue'),
    /**
     * `payload.source` on the PagerDuty event. Defaults to this service's
     * name so a trust & safety page is never mistaken for a concierge one in
     * the responder's timeline (the reason TS-302b made `source` required at
     * the package boundary).
     */
    PAGERDUTY_SOURCE: z.string().min(1).default('service-trust-safety'),
    /** Per-page request timeout in ms. A page fails fast; the incident is already durable. */
    PAGERDUTY_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5_000),
    // ───────────────────────────────────────────────────────────────────
    // SLA-breach sweep (TS-306-followup-1a). TS-300 stamped `sla_due_at`
    // at insert and cut the partial index for exactly this scan, and
    // nothing read it — an incident could sit untouched past its deadline
    // with no signal anywhere.
    //
    // **The sweep SURFACES; it does not page.** Paging on breach is
    // TS-306-followup-1b and is blocked on TS-300-followup-3: the SLA
    // budgets are placeholder constants, and waking someone at 3am
    // against a made-up deadline is worse than not waking them.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Kill switch for the SLA-breach sweep. NOT `z.coerce.boolean()` —
     * `Boolean("false")` is `true`, which makes a kill switch unflippable
     * from an env var (the TS-308a finding).
     */
    TRUST_SAFETY_SLA_SWEEP_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Repeat interval, in milliseconds. Default 900 000 (15 minutes) —
     * the tightest budget in force is `critical` at two hours, so a
     * quarter-hour resolution is well inside anything actionable while
     * keeping the scan volume trivial.
     */
    TRUST_SAFETY_SLA_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
    /**
     * Cap on how many breached incidents the sweep ENUMERATES (and
     * therefore logs) per tick. The breach COUNT is never capped — it
     * comes from a separate `count()` — so a truncated enumeration can
     * never make the metric under-report.
     */
    TRUST_SAFETY_SLA_SWEEP_MAX_LOGGED: z.coerce.number().int().positive().max(500).default(25),

    /**
     * Runbook the responder opens on a critical incident page (TS-306
     * acceptance: "runbook URL embedded in the page payload"). Optional —
     * unset simply omits the link rather than paging with a broken one.
     *
     * Config rather than a constant because the runbook lives in whatever
     * wiki the ops team runs, which differs per environment and is not the
     * codebase's to know.
     */
    TRUST_SAFETY_RUNBOOK_URL: z
      .string()
      .url('TRUST_SAFETY_RUNBOOK_URL must be a valid URL')
      .optional(),
    /**
     * Base URL of the ops console, used to build the deep link a responder
     * follows to the incident. Optional for the same reason.
     */
    TRUST_SAFETY_OPS_CONSOLE_BASE_URL: z
      .string()
      .url('TRUST_SAFETY_OPS_CONSOLE_BASE_URL must be a valid URL')
      .optional(),

    // ───────────────────────────────────────────────────────────────────
    // OpenTelemetry (TS-306-followup-1c). This service shipped without any
    // observability wiring at all — no tracing dependency, no meter
    // provider, no `/metrics` route — while its k8s ConfigMap already
    // declared `OTEL_TRACES_ENABLED` / `OTEL_METRICS_ENABLED` (TS-300-
    // followup-2 mirrored the concierge base). The values were being
    // dropped on the floor by `loadEnv`'s key-pick. Declaring them here is
    // what makes the ConfigMap tell the truth. CLAUDE.md §10; PDD §20.5.
    // Same coercion shape as service-ads / service-subscription.
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
    super(`service-trust-safety env validation failed: ${EnvValidationError.format(issues)}`);
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
  // Stripping them here keeps strict validation on OUR config (a typo'd or
  // missing required var still fails) while tolerating the open 12-factor
  // env namespace.
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
