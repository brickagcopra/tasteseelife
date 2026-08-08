import {
  BOOKING_ACCEPT_WINDOW_MINUTES_DEFAULT,
  BOOKING_ACCEPT_WINDOW_MINUTES_MAX,
  BOOKING_ACCEPT_WINDOW_MINUTES_MIN,
} from '@taste-and-see/contracts';
import { z } from 'zod';

/**
 * Environment-variable schema for service-booking.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11: never hardcode environment-dependent values).
 *
 * Clusters of env shipping with each task:
 *
 *   - TS-060 — `DATABASE_URL`, `PORT`, `LOG_LEVEL`, `NODE_ENV`,
 *     `SERVICE_VERSION` (skeleton). Only Postgres-side env at this
 *     stage because TS-060 ships the lifecycle state machine + the
 *     core row, not any authenticated HTTP surface.
 *
 *   - TS-060-followup-1 — adds three clusters now that the
 *     authenticated REST surface lands:
 *
 *       1. **JWT verification** — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *          `JWT_AUDIENCE`. service-booking verifies access tokens
 *          minted by service-identity (HS256 in Phase 1; RS256 +
 *          public-key fanout arrives with TS-022-followup-2). Mirrors
 *          service-provider / service-household / service-subscription
 *          env contract.
 *
 *       2. **Idempotency cache** — `REDIS_URL` +
 *          `IDEMPOTENCY_TTL_SECONDS` + `IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS`.
 *          The `@Idempotent()` interceptor (`@taste-and-see/nest-idempotency`)
 *          backs every write endpoint here. Mirrors service-provider /
 *          service-household / service-subscription.
 *
 *       3. **Outbox producer** — `OUTBOX_PRODUCER_SERVICE` (defaults
 *          to `service-booking`). Used by the
 *          `@taste-and-see/nest-outbox` SDK as the `producer_service`
 *          column on every appended event row.
 *
 *   - TS-061 — extends with RRULE limits; TS-064 — adds the household-
 *     tier lookup URL + secret for cross-service tier gating; TS-141
 *     wires the tenant-scoping Prisma extension. The env contract
 *     grows additively so each follow-up's wiring slice stays small
 *     and reviewable.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3015`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014. The
     * booking service gets the next-available port so the local dev
     * runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3027),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-060-followup-1 — JWT access-token verification. service-booking
    // consumes JWTs minted by service-identity (TS-022); the
    // AccessTokenGuard verifies the signature, audience, and issuer
    // before any authenticated handler sees the request. Phase 1 is
    // HS256 with a shared secret; Phase 2 (TS-022-followup-2) flips
    // to RS256.
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
    // TS-060-followup-1 — Idempotency cache. Backs the `@Idempotent()`
    // interceptor from `@taste-and-see/nest-idempotency`.
    // CLAUDE.md §3.3 / §17.5. Same wiring shape as service-provider /
    // service-household / service-subscription.
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
    // TS-060-followup-1 — Outbox producer SDK. Names the service in the
    // `producer_service` column the SDK stamps on every appended
    // event row, used by the relay's per-service observability.
    // ───────────────────────────────────────────────────────────────────

    OUTBOX_PRODUCER_SERVICE: z.string().min(1).default('service-booking'),

    // ───────────────────────────────────────────────────────────────────
    // TS-308a — Impossible-travel anomaly detection over provider
    // check-ins (PRD §10.13; PDD §17.3). Service-booking's FIRST BullMQ
    // queue; it was outbox-producer + outbox-consumer, never a scheduler.
    // The sweep runs in-process rather than as a worker app for the
    // TS-293 `RbacRevokerRunner` reason: it needs booking's own Prisma
    // client, and a worker app would either breach CLAUDE.md §2.3 or
    // need an internal bulk API with no other caller.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Kill switch. `false` creates no queue and no worker at all — for
     * one-off Jobs, Redis-less environments, and the case where a
     * mis-tuned threshold is filling the trust & safety queue and ops
     * needs it off NOW without a redeploy of the detector logic.
     */
    BOOKING_ANOMALY_DETECTION_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      // NOT `z.coerce.boolean()` — that is `Boolean(value)`, under which
      // the string "false" is TRUE, so the kill switch would be
      // unflippable from an env var. Same shape as identity's
      // `RBAC_REVOKER_ENABLED`.
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Interval between sweeps, in ms. Default 15 minutes. The sweep is
     * cheap (one indexed window scan) and the signal is not urgent
     * enough for a tighter loop — a spoofed check-in is reviewed by a
     * human on an 8h SLA, not paged at 3am.
     */
    BOOKING_ANOMALY_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
    /**
     * How far back each sweep looks, in hours. Default 24.
     *
     * Deliberately much wider than the interval, and overlapping: a
     * suspicious PAIR straddles the boundary (a 09:00 and a 10:05
     * check-in are only a pair if both are in scope), so a window keyed
     * to the tick would miss exactly the journeys that cross it.
     * Re-examination is free because the event id is derived from the
     * check-in pair and the outbox insert is `ON CONFLICT DO NOTHING`.
     */
    BOOKING_ANOMALY_LOOKBACK_HOURS: z.coerce.number().int().positive().max(720).default(24),
    /**
     * Implied-speed ceiling in km/h, above which a consecutive pair of
     * check-ins is reported. Default 1,000 — above commercial cruise, so
     * a provider who flies to a family emergency is not reported, and
     * below anything a spoofed location implies. **Unconfirmed against
     * real provider movement** (there is none yet); see the constant's
     * doc-block in `impossible-travel-policy.ts` for the full reasoning.
     */
    BOOKING_ANOMALY_MAX_SPEED_KPH: z.coerce.number().positive().default(1_000),

    // ───────────────────────────────────────────────────────────────────
    // TS-308c — Mass-cancellation detection (PRD §10.13; PDD §17.3;
    // CLAUDE.md §12). The SECOND detector on the same sweep: it shares
    // TS-308a's queue, interval and kill switch rather than standing up a
    // second timer. Its own window and thresholds, because "how far back
    // do cancellations count" and "how far apart can two check-ins be"
    // are unrelated questions.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Per-detector kill switch. `false` leaves the sweep running for
     * impossible travel and skips the cancellation evaluation entirely.
     * Separate from `BOOKING_ANOMALY_DETECTION_ENABLED` because the two
     * detectors have independent thresholds and independent false-positive
     * modes: a mis-tuned cancellation threshold filling the trust & safety
     * queue must not cost ops the location detector as well.
     */
    BOOKING_MASS_CANCELLATION_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      // NOT `z.coerce.boolean()` — under coerce the string "false" is
      // TRUE, so the kill switch would be unflippable from an env var.
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Rolling window, in hours. Default 24 — a day is the unit the
     * behaviour happens in ("cancelled their whole Tuesday"). Shorter
     * splits one sitting across two evaluations and never breaches;
     * longer blurs an acute event into ordinary attrition.
     */
    BOOKING_MASS_CANCELLATION_WINDOW_HOURS: z.coerce.number().int().positive().max(720).default(24),
    /**
     * Distinct cancellation decisions against one PROVIDER inside the
     * window before a finding is emitted. Default 5 — roughly a
     * provider's whole day of committed care. **Unconfirmed**; see the
     * constant's doc-block in `mass-cancellation-policy.ts`.
     */
    BOOKING_MASS_CANCELLATION_PROVIDER_THRESHOLD: z.coerce.number().int().positive().default(5),
    /**
     * Distinct cancellation decisions by one HOUSEHOLD inside the window.
     * Default 6 — deliberately higher than the provider threshold even
     * though households book fewer visits, because the dominant benign
     * explanation is a family cancelling everything after a health event.
     * **Unconfirmed**; see the constant's doc-block.
     */
    BOOKING_MASS_CANCELLATION_HOUSEHOLD_THRESHOLD: z.coerce.number().int().positive().default(6),

    // ───────────────────────────────────────────────────────────────────
    // TS-304 — Outbox CONSUMER SDK. Service-booking's first consumer
    // cluster: it was producer-only through TS-303. It consumes the
    // `trust_safety.booking_hold.requested` / `.released` pair so a
    // serious concern suspends a subject's visits (PRD §10.14; PDD §16.1;
    // CLAUDE.md §12). Same shape and defaults as service-accounting /
    // service-trust-safety; the Redis connection is the `REDIS_URL`
    // already configured above.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Consumer name within the `service-booking` group — the Redis Streams
     * consumer identity. Distinct per replica so `XAUTOCLAIM` can tell a
     * crashed pod's pending entries from a live pod's. Deployments set this
     * from the pod name; `default` suits single-replica local dev.
     */
    OUTBOX_CONSUMER_NAME: z.string().min(1).default('default'),
    /**
     * Stream prefix, which MUST match the relay's `STREAM_NAME_PREFIX`.
     * Override both ends together or this service silently reads an empty
     * stream forever — which here means holds never apply and a suspended
     * provider keeps visiting families.
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
     * This interval is the upper bound on how long a newly-opened critical
     * incident can take to freeze a booking, so it stays low.
     */
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(1_000),

    // ───────────────────────────────────────────────────────────────────
    // TS-064 — Tier gating (PRD §5.1 / §5.2; CLAUDE.md §12). The booking
    // service consults two read-side caches (household tier + provider
    // tier) before creating a booking. Two modes:
    //
    //   - `enforce`  — both snapshots required; missing snapshot or
    //                  tier mismatch rejects the booking with HTTP 409.
    //   - `advisory` — log warnings on missing snapshot or tier mismatch
    //                  but allow the booking. Phase-1 default while the
    //                  event-driven cache hydration is still on the
    //                  follow-up runway (TS-064-followup; lands with
    //                  TS-142). Lets ops bring the snapshots up via the
    //                  internal HTTP endpoint at their own cadence.
    //
    // The internal HTTP endpoint (`POST /api/v1/internal/booking/tier-
    // snapshots/{household,provider}`) is pinned to a shared-secret
    // header — same defence-in-depth pattern as service-identity's KYC
    // internal-dispatch endpoint (TS-026). The TS-151 NetworkPolicy will
    // restrict the route to in-cluster callers; the header is the
    // application-layer guard alongside that network policy.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Booking tier-gating enforcement mode. `enforce` rejects bookings
     * with missing snapshots or mismatched tiers (Tier-3 household with
     * non-Elite provider). `advisory` logs the violation and allows the
     * booking. Phase-1 default is `advisory` because the snapshot cache
     * hydrates manually until TS-142 brings the event-driven path live.
     */
    BOOKING_TIER_GATING_MODE: z.enum(['enforce', 'advisory']).default('advisory'),
    /**
     * Header carrying the shared-secret for the internal tier-snapshot
     * upsert endpoints. Mirrors `KYC_DISPATCH_HEADER_NAME` shape; the
     * default is `x-internal-api-key`. Lowercase by convention so the
     * `request.header(...)` call is case-stable.
     */
    BOOKING_TIER_DISPATCH_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    /**
     * Shared-secret value compared against `BOOKING_TIER_DISPATCH_HEADER_NAME`.
     * Must be at least 32 characters; never logged. Rotated via the
     * standard secrets-manager flow (CLAUDE.md §3.5).
     */
    BOOKING_TIER_DISPATCH_API_KEY: z
      .string()
      .min(32, 'BOOKING_TIER_DISPATCH_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-235 — Wellness-summary worker internal surface (PRD §6.4, §6.9;
    // PDD §12.2). The monthly wellness-summary worker calls
    // `GET /api/v1/internal/bookings/households/:householdId/seniors/
    // :seniorId/wellness-observation-summary` to fold each senior's
    // prior-N-day observation roll-up into the email. Pinned to a
    // shared-secret header — same defence-in-depth pattern as the
    // tier-snapshot dispatch endpoints above (TS-064) and service-
    // household's visit-prep internal snapshot (TS-208). The TS-151
    // NetworkPolicy further restricts the route to in-cluster callers.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Header carrying the shared-secret for the internal wellness-
     * observation-summary read endpoint. Mirrors
     * `BOOKING_TIER_DISPATCH_HEADER_NAME`; the default is
     * `x-internal-api-key`. Lowercase by convention so the
     * `request.header(...)` call is case-stable.
     */
    BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    /**
     * Shared-secret value compared against
     * `BOOKING_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME`. Must be at least
     * 32 characters; never logged. Rotated via the standard secrets-
     * manager flow (CLAUDE.md §3.5).
     */
    BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY: z
      .string()
      .min(32, 'BOOKING_WELLNESS_SUMMARY_INTERNAL_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-205 — Provider accept window (PRD §7.3). When a family
    // submits a booking, the assigned provider has this many minutes
    // to accept or decline before the auto-decline worker
    // (TS-205-followup-1) transitions the booking to `declined` and
    // re-routes the request to the concierge queue. Phase-1 stop-gap
    // — until the worker lands, the accept endpoint refuses past-
    // window accepts so a booking can't slip through silently.
    //
    // Bounds enforced at the contract layer
    // (`BOOKING_ACCEPT_WINDOW_MINUTES_MIN`/`_MAX`) so a misconfigured
    // env var fails fast at boot.
    // ───────────────────────────────────────────────────────────────────
    BOOKING_ACCEPT_WINDOW_MINUTES: z.coerce
      .number()
      .int()
      .min(BOOKING_ACCEPT_WINDOW_MINUTES_MIN)
      .max(BOOKING_ACCEPT_WINDOW_MINUTES_MAX)
      .default(BOOKING_ACCEPT_WINDOW_MINUTES_DEFAULT),

    // ───────────────────────────────────────────────────────────────────
    // Observability (TS-060-followup-4). OpenTelemetry tracing +
    // Prometheus metrics surface backed by @taste-and-see/tracing, wired
    // through @taste-and-see/nest-observability. See PDD §20.5 and
    // CLAUDE.md §10. service-booking mirrors the env shape service-identity
    // established as the FIRST real consumer of the shared tracing package
    // (TS-020-followup-1) and service-provider followed (TS-050-followup-1).
    //
    //   - OTEL_TRACES_ENABLED            — defaults true; flip to false to
    //     short-circuit `initTracing` (e.g. in CI runs that don't ship
    //     spans to a collector). Consulted at boot, before any service
    //     module is imported.
    //   - OTEL_METRICS_ENABLED           — same shape for `initMetrics`. The
    //     /metrics scrape endpoint is wired unconditionally (returns an
    //     empty document when metrics are disabled, so Prometheus doesn't
    //     alarm on a missing target).
    //   - OTEL_EXPORTER_OTLP_ENDPOINT    — optional explicit endpoint
    //     override; re-declared here as `optional()` with `.url()` so the
    //     env validator surfaces a typo at boot rather than silently
    //     falling back.
    //
    // NOTE: `src/observability/bootstrap.ts` reads these directly from
    // `process.env` at module-load time (before Zod runs) so OTel can patch
    // `http` / `pg` / `ioredis` before any module loads. The re-declaration
    // here keeps the `.strict()` schema from rejecting a configured pod and
    // gives a typo'd endpoint a fail-fast boot error.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Enable / disable OpenTelemetry tracing initialisation. Defaults true
     * in every environment — local dev gets spans pushed to a collector
     * when one is running (and dropped silently otherwise; the OTLP
     * exporter does not block the request path). CI sets this to `false`
     * to keep test runs deterministic.
     */
    OTEL_TRACES_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Enable / disable the Prometheus metrics surface. Defaults true. The
     * /metrics endpoint stays wired regardless — when this is false, the
     * handler returns an empty exposition document so Prometheus's
     * missing-target alert does not fire.
     */
    OTEL_METRICS_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Explicit OTLP/HTTP traces endpoint. When unset the tracing package
     * falls back to the standard OTEL_* env conventions and ultimately
     * `http://localhost:4318/v1/traces`. Re-declared here with `.url()`
     * validation so a typo fails boot rather than surfacing as a
     * late-running silent exporter error.
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
    super(`service-booking env validation failed: ${EnvValidationError.format(issues)}`);
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
