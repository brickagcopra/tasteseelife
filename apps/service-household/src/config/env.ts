import { z } from 'zod';

/**
 * Environment-variable schema for service-household.
 *
 * Validated once at bootstrap. Failure aborts the process with a structured
 * error rather than silently falling back to defaults — fail-fast keeps
 * misconfigured deployments out of the request path (CLAUDE.md §17.11:
 * never hardcode environment-dependent values).
 *
 * Two clusters of secrets ride this schema beyond the TS-030 skeleton:
 *
 *   1. **Intake encryption** (TS-031) — AES-256-GCM symmetric key for the
 *      sensitive PII payload (DOB + freeform notes). Key versioning matches
 *      the `MfaSecretCipherService` pattern in `service-identity` so rotation
 *      is a single env-var bump + a backfill worker (deferred — Phase 2).
 *
 *   2. **Access-token verification** — the JWT secret + audience/issuer
 *      pinning that lets the `AccessTokenGuard` reject tokens issued by an
 *      unrelated issuer. Phase 1 is HS256 with a shared secret across
 *      `service-identity` (issuer) and every consumer (`service-household`
 *      here). RS256 + public-key distribution arrives in TS-022-followup-2.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3011),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // Intake payload encryption (TS-031). AES-256-GCM symmetric key,
    // versioned. Mirrors the contract in service-identity's
    // `MFA_TOTP_ENC_KEY` / `MFA_TOTP_ENC_KEY_VERSION` so an operator who
    // has rotated one knows how to rotate the other.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Base64-encoded 32-byte (256-bit) symmetric key for AES-256-GCM
     * at-rest encryption of the sensitive senior intake payload
     * (DOB + freeform dietary/allergy/mobility/medical notes).
     *
     * Sourced from secrets manager (Vault / AWS Secrets Manager) and
     * never written to source. DB write access alone must NOT grant
     * the ability to read the encrypted payload — envelope encryption
     * is the second layer beyond Postgres's encryption-at-rest baseline
     * (PDD §11.3, §21.3).
     *
     * Validated to decode to exactly 32 bytes — wrong-length keys are
     * a configuration bug we want to fail fast on at boot, not at the
     * first intake save in production.
     */
    HOUSEHOLD_INTAKE_ENC_KEY: z
      .string()
      .min(1, 'HOUSEHOLD_INTAKE_ENC_KEY is required')
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'HOUSEHOLD_INTAKE_ENC_KEY must be a base64 string that decodes to exactly 32 bytes (AES-256 key)'),
    /**
     * Integer key version stored alongside each encrypted intake
     * payload. Forward-compatible rotation: when the key rotates we
     * increment this number; new rows encrypt under the new version,
     * old rows stay readable as long as the prior key remains in the
     * keyring. Phase 1 ships with a single key (version=1).
     */
    HOUSEHOLD_INTAKE_ENC_KEY_VERSION: z.coerce.number().int().positive().default(1),

    // ───────────────────────────────────────────────────────────────────
    // Access-instructions encryption (TS-032). AES-256-GCM symmetric key,
    // versioned. SEPARATE key from the intake payload — door codes and
    // alarm codes have a sharper threat model than medical-ish notes, so
    // bounding blast radius per data class is worth the operational cost
    // of an extra secret. Same rotation contract as the intake key.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Base64-encoded 32-byte (256-bit) symmetric key for AES-256-GCM
     * at-rest encryption of the household access-instructions payload
     * (door code, key location, alarm code + disarm instructions,
     * parking instructions, doorman info, pet info, general notes).
     *
     * Sourced from secrets manager (Vault / AWS Secrets Manager) and
     * never written to source. Independent of `HOUSEHOLD_INTAKE_ENC_KEY`
     * so the two data classes can be rotated on different cadences and
     * a leak of either key bounds blast radius to one class.
     *
     * Validated to decode to exactly 32 bytes — wrong-length keys are
     * a configuration bug we want to fail fast on at boot, not at the
     * first access-instruction save in production.
     */
    HOUSEHOLD_ACCESS_ENC_KEY: z
      .string()
      .min(1, 'HOUSEHOLD_ACCESS_ENC_KEY is required')
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'HOUSEHOLD_ACCESS_ENC_KEY must be a base64 string that decodes to exactly 32 bytes (AES-256 key)'),
    /**
     * Integer key version stored alongside each encrypted access-
     * instructions payload. Same rotation semantics as
     * `HOUSEHOLD_INTAKE_ENC_KEY_VERSION` — Phase 1 ships at 1; bump on
     * rotation and run the backfill worker.
     */
    HOUSEHOLD_ACCESS_ENC_KEY_VERSION: z.coerce.number().int().positive().default(1),

    // ───────────────────────────────────────────────────────────────────
    // Access-token verification. service-household consumes JWTs minted
    // by service-identity (TS-022); the AccessTokenGuard verifies the
    // signature, audience, and issuer before any authenticated handler
    // sees the request. Phase 1 is HS256 with a shared secret; Phase 2
    // (TS-022-followup-2) flips to RS256 with the public key fetched
    // from the issuer / gateway.
    // ───────────────────────────────────────────────────────────────────

    /**
     * HS256 verification secret for access tokens issued by
     * service-identity. Same value as service-identity's
     * `JWT_ACCESS_SECRET` — sharing a symmetric secret across the
     * issuer and verifier is the Phase 1 contract.
     *
     * Once a second verifier exists (gateway-api, TS-140) we move to
     * RS256 and the public-key fanout in TS-022-followup-2.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /**
     * Pinned issuer claim — must match the `JWT_ISSUER` configured on
     * service-identity. A token issued by an unrelated service (or a
     * compromised secondary issuer) will not pass the audience/issuer
     * check even if the secret matches by accident.
     */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /**
     * Pinned audience claim. Same default as service-identity's
     * `JWT_AUDIENCE` — represents "tokens minted for the Taste & See
     * platform API surface, regardless of which downstream service
     * verifies them".
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
    // Idempotency cache (TS-044-followup-1). Backs the @Idempotent()
    // interceptor exposed by @taste-and-see/nest-idempotency. CLAUDE.md
    // §3.3 / §17.5. Same wiring shape as service-subscription.
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
    // Internal visit-prep snapshot surface (TS-208). The api-gateway BFF
    // posts the shared-secret header to read the senior's operational
    // intake + memory recipes when assembling the provider-facing prep
    // checklist. NetworkPolicy (TS-151) restricts the route to in-cluster
    // callers; this header is the application-layer defence-in-depth
    // (CLAUDE.md §3.5). Mirrors the shape of service-provider's
    // `PROVIDER_DISCOVERY_INTERNAL_*` env pair (TS-053).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Header name the gateway BFF presents the shared secret on. Lower-
     * cased at read time — HTTP headers are case-insensitive. Default
     * matches the search-indexer / provider-discovery convention so an
     * operator who has rotated one knows how to rotate the other.
     */
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-household-visit-prep-internal-api-key'),
    /**
     * Shared-secret API key for the `/api/v1/internal/seniors/:seniorId/prep-snapshot`
     * endpoint (TS-208). Mirrors the
     * `PROVIDER_DISCOVERY_INTERNAL_API_KEY` floor — minimum length 32
     * to keep brute-force out of reach. Sourced from secrets manager;
     * never written to source.
     */
    HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: z
      .string()
      .min(32, 'HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // Internal wellness-summary households surface (TS-235). The monthly
    // wellness-summary worker posts the shared-secret header to walk the
    // active-household population (each household's active seniors + their
    // `notes` consent flag + the active recipients to notify) in cursor-
    // paginated pages. NetworkPolicy (TS-151) restricts the route to in-
    // cluster callers; this header is the application-layer defence-in-
    // depth (CLAUDE.md §3.5). Mirrors the `HOUSEHOLD_VISIT_PREP_INTERNAL_*`
    // pair above (TS-208).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Header name the wellness-summary worker presents the shared secret
     * on. Lower-cased at read time — HTTP headers are case-insensitive.
     * Default matches the visit-prep / provider-discovery convention so
     * an operator who has rotated one knows how to rotate the other.
     */
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-internal-api-key'),
    /**
     * Shared-secret API key for the
     * `/api/v1/internal/wellness-summary/households` endpoint (TS-235).
     * Mirrors the `HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY` floor — minimum
     * length 32 to keep brute-force out of reach. Sourced from secrets
     * manager; never written to source.
     */
    HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY: z
      .string()
      .min(32, 'HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // Internal household-memberships surface (TS-505d2-followup-5). The
    // api-gateway calls this to establish a request's household tenant
    // scope — it is the seam that makes CLAUDE.md §3.2's household scoping
    // reachable at all, since no access token has ever carried anything
    // but `global`. Its own secret pair rather than a reuse of the two
    // above: this route answers an AUTHORISATION question on the hot path
    // for every authenticated request, so it deserves its own blast
    // radius and its own rotation. Mirrors the `HOUSEHOLD_VISIT_PREP_
    // INTERNAL_*` pair (TS-208).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Header name the api-gateway presents the shared secret on. Lower-
     * cased at read time — HTTP headers are case-insensitive. Default
     * matches the visit-prep / provider-discovery convention so an
     * operator who has rotated one knows how to rotate the other.
     */
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: z
      .string()
      .min(1)
      .default('x-household-memberships-internal-api-key'),
    /**
     * Shared-secret API key for the
     * `/api/v1/internal/users/:userId/household-memberships` endpoint.
     * Same 32-character floor as its siblings. Sourced from secrets
     * manager; never written to source.
     */
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: z
      .string()
      .min(32, 'HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY must be at least 32 characters'),
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
    super(`service-household env validation failed: ${EnvValidationError.format(issues)}`);
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
