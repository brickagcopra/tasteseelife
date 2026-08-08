import { z } from 'zod';

/**
 * Environment-variable schema for service-identity.
 *
 * Validated once at bootstrap. Failure aborts the process with a structured
 * error rather than silently falling back to defaults — fail-fast keeps
 * misconfigured deployments out of the request path (CLAUDE.md §17.11:
 * never hardcode environment-dependent values).
 *
 * JWT_ACCESS_SECRET enters with TS-022 (login + rotating refresh). It is
 * the HS256 signing secret used by `service-identity` to mint access
 * tokens and verified by `auth-sdk` consumers (gateway, downstream
 * services). Minimum length 32 bytes (HMAC-SHA256 block size) so a short
 * dev secret cannot accidentally ship to staging.
 *
 * The refresh-token secret is intentionally NOT a separate JWT signing
 * key — refresh tokens in this design are opaque random strings, not
 * JWTs (see `TokenService`). The DB-stored SHA-256 hash is the
 * verification path; no signing key is needed.
 *
 * MFA (TS-023) adds a second cluster of secrets: an AES-256-GCM key
 * for at-rest encryption of TOTP shared secrets, and a separate HS256
 * signing secret for the short-lived challenge JWT. Compartmentalising
 * these keys from `JWT_ACCESS_SECRET` is intentional — see the
 * field-level docs below for the threat-model rationale.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3010),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),
    SERVICE_VERSION: z.string().default('dev'),

    /**
     * HS256 signing secret for access tokens. Phase 1 picks HS256 because
     * service-identity is currently the only token issuer AND verifier
     * (the auth-sdk's `verifyAccessToken` defaults to HS256). When the
     * gateway-api lands as a separate verifier (TS-140) we move to RS256
     * so the public key can be distributed without sharing the signing
     * secret. The migration is forward-compatible: add an `RSA` mode to
     * `TokenService`, run dual-signing during the cutover window, drop
     * HS256 once verifiers have rotated.
     */
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /** Access-token lifetime in seconds. Default 900 (15 min) — CLAUDE.md §3.1. */
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    /** Refresh-token lifetime in seconds. Default 30d — CLAUDE.md §3.1. */
    JWT_REFRESH_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(60 * 60 * 24 * 30),
    /** Issuer claim. Tokens with a different `iss` are rejected by verifiers. */
    JWT_ISSUER: z.string().default('taste-and-see/service-identity'),
    /**
     * Audience claim. Set to a stable identifier that downstream verifiers
     * pin (e.g. the API gateway). Default fits the Phase 1 single-service
     * topology; gateway-api (TS-140) will likely override.
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
    /**
     * `Secure` flag on the refresh-token cookie. True in non-development
     * environments; false in local dev so HTTP works against
     * `localhost:3010`. Production deployments override to `true` via
     * env regardless of NODE_ENV — defence in depth.
     */
    REFRESH_COOKIE_SECURE: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),

    // ───────────────────────────────────────────────────────────────────
    // MFA (TS-023). Cluster of related env vars: at-rest encryption key
    // for the TOTP shared secret, the challenge JWT signing secret, and
    // the RFC 6238 protocol parameters. Defaults match the standards-
    // compliant TOTP setup that every authenticator app supports
    // out-of-the-box (30s period, 6 digits, ±1 step skew window).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Base64-encoded 32-byte (256-bit) symmetric key for AES-256-GCM
     * at-rest encryption of TOTP shared secrets. The shared secret is
     * sensitive credential material — DB write access alone must NOT
     * grant the ability to read or forge MFA secrets, hence envelope
     * encryption with a key sourced from secrets manager (Vault / AWS
     * Secrets Manager) and never written to source.
     *
     * Validated to decode to exactly 32 bytes — wrong-length keys are
     * a configuration bug we want to fail fast on at boot, not at the
     * first MFA enrollment in production.
     */
    MFA_TOTP_ENC_KEY: z
      .string()
      .min(1, 'MFA_TOTP_ENC_KEY is required')
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'MFA_TOTP_ENC_KEY must be a base64 string that decodes to exactly 32 bytes (AES-256 key)'),
    /**
     * Integer key version stored alongside each encrypted MFA secret.
     * Forward-compatible rotation: when the key rotates we increment
     * this number; new rows encrypt under the new version, old rows
     * stay readable as long as the prior key remains in the keyring.
     * Phase 1 ships with a single key (version=1); the multi-version
     * keyring lands when rotation operationalises.
     */
    MFA_TOTP_ENC_KEY_VERSION: z.coerce.number().int().positive().default(1),
    /**
     * HS256 signing secret for the MFA challenge JWT. Deliberately
     * separate from `JWT_ACCESS_SECRET` — compartmentalising the keys
     * means a leaked access-token signing key does not also grant the
     * ability to mint a "yes you cleared MFA" challenge that bypasses
     * the second factor. Same minimum-length contract as the access
     * token secret.
     */
    MFA_CHALLENGE_SECRET: z
      .string()
      .min(32, 'MFA_CHALLENGE_SECRET must be at least 32 characters (HMAC-SHA256 block size)'),
    /**
     * MFA challenge lifetime in seconds. Default 300 (5 min) — long
     * enough that a user can fish their phone out of a pocket and
     * type a code, short enough that a captured challenge token has a
     * tightly-bounded replay window. The single-use jti table
     * (`identity.mfa_challenges`) collapses the window further to
     * "first use wins."
     */
    MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    /**
     * RFC 6238 step length in seconds. 30 is the universal default
     * across Google Authenticator, Authy, 1Password, etc. Changing
     * this would mean every existing QR re-issued — keep at 30.
     */
    MFA_TOTP_PERIOD_SECONDS: z.coerce.number().int().positive().default(30),
    /**
     * Number of decimal digits in a TOTP code. 6 is the universal
     * default; 8 is RFC-permitted but few authenticator apps render
     * it well.
     */
    MFA_TOTP_DIGITS: z.coerce.number().int().min(6).max(8).default(6),
    /**
     * Step-skew tolerance — how many ±step windows we accept beyond
     * the current step to compensate for client clock drift. 1 means
     * we accept the previous step, the current step, and the next
     * step — total 90s acceptance window (3 × 30s). RFC 6238 §6
     * ("Resynchronization") recommends a small window; 1 is the
     * standard production value.
     */
    MFA_TOTP_WINDOW: z.coerce.number().int().min(0).max(5).default(1),
    /**
     * Issuer string baked into the otpauth:// URL. Authenticator apps
     * render this as the account label (e.g. "Taste & See: alice@x").
     * Use the human brand here — `JWT_ISSUER`'s `taste-and-see/...`
     * form is meaningful to verifiers but ugly in a phone screenshot.
     */
    MFA_TOTP_ISSUER: z.string().min(1).default('Taste & See'),

    // ───────────────────────────────────────────────────────────────────
    // Idempotency cache (TS-044-followup-2). Backs the @Idempotent()
    // interceptor exposed by @taste-and-see/nest-idempotency. CLAUDE.md
    // §3.3 / §17.5. Same wiring shape as service-subscription (TS-044)
    // and service-household (TS-044-followup-1).
    //
    // Today this service only decorates POST /api/v1/auth/signup — the
    // pre-auth endpoint where Idempotency-Key replay safety matters most
    // (a network retry after the user record was created but the response
    // never reached the client would, without the cache, surface as a
    // confusing 409 email-already-exists instead of the original 201).
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
    // Email verification (TS-510).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Lifetime of a single-use email-verification token, in seconds.
     * Default 24h — long enough to survive an overnight signup and a
     * next-morning click, short enough that a link sitting in a shared or
     * forwarded mailbox stops being a credential within a day. Capped at 7
     * days so a deploy-time typo cannot mint effectively permanent links;
     * floored at 5 minutes so a typo in the other direction does not make
     * every link expire before the mail is delivered.
     */
    EMAIL_VERIFICATION_TTL_SECONDS: z.coerce.number().int().min(300).max(604_800).default(86_400),

    // ───────────────────────────────────────────────────────────────────
    // RBAC revoker (TS-293). BullMQ-scheduled sweep that durably revokes
    // role assignments whose `expires_at` has passed. Expiry is already
    // enforced at read time (`getActiveAssignments` filters), so the
    // sweep's cadence is an observability/notification concern, not a
    // security window — a missed tick never extends anyone's access.
    // The queue rides the shared REDIS_URL with the §3.7-namespaced
    // prefix `{NODE_ENV}:service-identity:queue`.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Master switch for the rbac-revoker queue + worker. Default true in
     * a running service; unit tests never construct the runner against a
     * real Redis (the BullMQ handles are injected), and ephemeral
     * environments that run without Redis-backed scheduling (e.g. a
     * one-off migration Job) flip this off.
     */
    RBAC_REVOKER_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Repeat interval for the sweep's BullMQ job scheduler, in
     * milliseconds. Default 300 000 (5 minutes) — tight enough that a
     * lapsed grant is revoked + notified promptly, loose enough that the
     * steady-state sweep (usually zero rows) is negligible load. The
     * job scheduler dedupes across identity replicas: one sweep per
     * tick cluster-wide, not per pod.
     */
    RBAC_REVOKER_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
    /**
     * Max expired rows revoked per transaction batch. Bounds both the
     * transaction size and the per-tick outbox append burst (each row
     * emits one `identity.role_assignment.expired` event). 500 keeps the
     * batch comfortably under Prisma's interactive-transaction timeout
     * at Phase-1 scale; the sweep loops batches until drained.
     */
    RBAC_REVOKER_BATCH_SIZE: z.coerce.number().int().positive().max(5_000).default(500),

    // ───────────────────────────────────────────────────────────────────
    // Overdue data-subject-request sweep (TS-309a-followup-2). `due_at`
    // has been stamped at intake since TS-309a and the partial index was
    // cut for exactly this scan, but nothing watched the clock — a
    // statutory request could pass its deadline with no signal at all.
    //
    // The sweep is READ-ONLY and emits observability, never a row change:
    // "overdue" is a function of `due_at` and the clock, so a status
    // would go stale the instant an extension moved the deadline.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Kill switch for the overdue-DSAR sweep. Same posture as
     * `RBAC_REVOKER_ENABLED`: unit tests never touch real Redis (the
     * BullMQ handles are injected) and Redis-less one-off Jobs flip this
     * off. NOT `z.coerce.boolean()` — `Boolean("false")` is `true`, which
     * makes a kill switch unflippable from an env var (the TS-308a
     * finding).
     */
    PRIVACY_OVERDUE_SWEEP_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Repeat interval for the sweep, in milliseconds. Default 3 600 000
     * (1 hour) — deliberately far slacker than the rbac-revoker's 5
     * minutes. The deadline this watches is measured in DAYS, so a
     * tighter cadence would buy nothing and only add scan volume; an hour
     * is well inside the resolution anyone can act on.
     */
    PRIVACY_OVERDUE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
    /**
     * How far ahead of `due_at` a live request starts counting as "due
     * soon", in days. Default 7. A clock you only hear about once it has
     * expired is not an alarm — by then the only available action is to
     * be late. This feeds a gauge, not a per-row warning: the point is
     * lead time, not noise.
     */
    PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS: z.coerce.number().int().positive().max(90).default(7),
    /**
     * Cap on how many overdue rows the sweep ENUMERATES (and therefore
     * logs) per tick. The overdue COUNT is never capped — it comes from a
     * separate `count()` — so a truncated enumeration can never make the
     * metric under-report. When the cap bites, the sweep says so on the
     * summary line rather than quietly showing the first N.
     */
    PRIVACY_OVERDUE_SWEEP_MAX_LOGGED: z.coerce.number().int().positive().max(500).default(25),

    /**
     * Absolute lifetime of an admin impersonation session's refresh
     * family, in seconds (TS-297). Default 3600 (1 hour) — long enough
     * for a support diagnostic pass, far shorter than the ordinary
     * 30-day refresh TTL. The access token keeps the standard 15-minute
     * `JWT_ACCESS_TTL_SECONDS`. Capped at 24h: impersonation is a
     * session-scoped diagnostic tool, never a standing credential.
     */
    IMPERSONATION_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(86_400)
      .default(3_600),

    // ───────────────────────────────────────────────────────────────────
    // Login IP circuit breaker (TS-025-followup-1). Complement to the
    // per-user lockout (TS-025): a Redis-backed sliding-window counter
    // per source IP × `/api/v1/auth/login` that trips at a HIGHER
    // threshold than any single user's per-user gate. The use case is
    // credential stuffing — a single attacker probing many accounts
    // from one IP hits the IP gate before they hit any single user's
    // per-user gate. CLAUDE.md §3.1: "IP-level circuit breaker".
    //
    // The breaker counts ANY credential failure (no-user, soft-deleted,
    // inactive-status, bad-password) — the attacker doesn't know which
    // branch their probe hit, so the breaker shouldn't either. Returns
    // the same generic 401 as bad-password so the breaker state is
    // never an enumeration oracle.
    //
    // Defaults are conservative: 30 failures per 5-minute window — well
    // above any legitimate-user "I typed my password wrong" rate, well
    // below a credential-stuffing attack rate.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Maximum failed login attempts permitted per source IP per
     * `LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS` window before the breaker
     * trips. Default 30. Once tripped, subsequent attempts from that
     * IP get the same generic 401 as a bad password until the window
     * rolls.
     *
     * The threshold is deliberately above the per-user gate's lock
     * schedule (which starts charging from the 3rd consecutive
     * failure per account) so the IP layer only fires on cross-
     * account probing, not on a single legitimate user retyping
     * their password.
     */
    LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: z.coerce.number().int().positive().default(30),
    /**
     * Window length in seconds for the IP breaker's fixed-window
     * counter. Default 300 (5 minutes) — matches the CLAUDE.md §3.1
     * example. Shorter windows reduce false-positive carry-over from
     * legitimate cycling NAT IPs; longer windows are harder for an
     * attacker to wait out.
     */
    LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),

    /**
     * Per-address cooldown on `POST /api/v1/auth/verification-emails`
     * (TS-510-followup-3), in seconds.
     *
     * Keyed on the TARGET address, not the source IP — the gateway's
     * `sensitive` policy already covers one host hammering the endpoint,
     * and the shape this defends against is many hosts aimed at one
     * inbox. The address is attacker-chosen, so without this the endpoint
     * is a lever for mailing a stranger repeatedly from our domain.
     *
     * **60 seconds is an UNCONFIRMED product number** (the TS-300
     * SLA-budget posture). It has to be long enough that a flood is
     * pointless and short enough that a person who did not receive the
     * first mail is not left staring at a page — a minute is the
     * conventional answer to both, and nobody here has data. Whatever
     * replaces it must stay well under the token's own TTL
     * (`EMAIL_VERIFICATION_TTL_SECONDS`): a cooldown longer than the link
     * lasts would strand a user whose first link expired.
     */
    VERIFICATION_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().max(3_600).default(60),

    // ───────────────────────────────────────────────────────────────────
    // TS-510-followup-1 — email-verification-token prune. The table grows
    // one row per signup and one per resend, forever; the durable record
    // that an address was verified is `users.email_verified_at`, not the
    // token.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Operational lever, not a redeploy: false schedules no queue and no
     * worker at all. Same shape as `SUBSCRIPTION_DUNNING_SWEEP_ENABLED`.
     */
    VERIFICATION_TOKEN_PRUNE_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((value) => (typeof value === 'boolean' ? value : value.toLowerCase() !== 'false')),
    /**
     * Tick cadence. Default 6 hours — the work is housekeeping against a
     * retention window measured in days, so a tighter cadence would only
     * spend index scans rediscovering the same empty result.
     */
    VERIFICATION_TOKEN_PRUNE_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000),
    /**
     * How long a spent or expired row is kept, in days. Default 30 —
     * deliberately far longer than a token's own TTL. The rows survive
     * not because the platform needs them but because a support question
     * does ("did the link we sent you on Tuesday work?"), and a retention
     * tuned to the token's lifetime would delete the answer while the
     * question is still being asked.
     */
    VERIFICATION_TOKEN_PRUNE_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .max(3_650)
      .default(30),
    /**
     * Rows deleted per tick. Bounded because `email_verification_tokens`
     * is written by the signup transaction — an unbounded DELETE on a
     * first run against a long-lived table holds locks across a path
     * where latency is a customer sitting at a form.
     */
    VERIFICATION_TOKEN_PRUNE_BATCH_SIZE: z.coerce
      .number()
      .int()
      .positive()
      .max(100_000)
      .default(5_000),

    // ───────────────────────────────────────────────────────────────────
    // KYC (TS-026). Stripe Identity light verification surface for
    // provider onboarding (PDD §11.1: "Stripe Identity for provider
    // KYC light"). The provider-side caller (TS-051) drives session
    // creation; an internal HTTP dispatch from service-webhook delivers
    // identity.verification_session.* events back here for row
    // hydration. The cluster:
    //
    //   - STRIPE_SECRET_KEY            — outbound API credential. Twin
    //     of service-subscription's same-named env (separate process,
    //     same Stripe account; one secret distributed via the env
    //     manager).
    //   - STRIPE_API_VERSION           — optional API-version pin.
    //     Matches service-subscription's shape so a future SDK bump is
    //     coordinated across the platform.
    //   - STRIPE_IDENTITY_RETURN_URL   — where Stripe sends the user
    //     after they complete (or abandon) the verification flow.
    //     Server-rendered redirect target; never an open redirect —
    //     pre-validated to an allow-listed host at boot.
    //   - KYC_PAYLOAD_ENC_KEY          — base64 32-byte AES-256-GCM key
    //     for at-rest encryption of the Stripe verification_session
    //     payload. INDEPENDENT key from MFA's TOTP secret cipher
    //     (CLAUDE.md §3 / §3.5) — compartmentalised so a leaked MFA
    //     key does not also grant the ability to read every KYC row.
    //   - KYC_PAYLOAD_ENC_KEY_VERSION  — integer version stamped on
    //     each encrypted row. Increment on rotation; a backfill worker
    //     re-wraps legacy rows under the new key. Mirrors the
    //     MFA_TOTP_ENC_KEY_VERSION shape.
    //   - KYC_WEBHOOK_INTERNAL_API_KEY — shared-secret header the
    //     internal POST /api/v1/internal/kyc/webhook-events endpoint
    //     pins. service-webhook holds the same value in its env and
    //     presents it on dispatch. Defence-in-depth alongside the
    //     network-layer policy that limits the route to in-cluster
    //     callers (TS-151 NetworkPolicy).
    // ───────────────────────────────────────────────────────────────────

    /**
     * Stripe SDK credential. Used by `StripeIdentityClient` to create
     * verification sessions and to fetch session details. Same shape
     * as service-subscription's `STRIPE_SECRET_KEY` — one Stripe
     * account, the secret is duplicated across services because
     * Phase 1 keeps each service's env namespace independent (TS-150
     * Terraform-managed secrets manager will inject the same value
     * into both pods). Minimum length 20 to catch obvious typos /
     * empty-string copy-paste mishaps without hard-coding the
     * `sk_test_` / `sk_live_` prefix.
     */
    STRIPE_SECRET_KEY: z
      .string()
      .min(20, 'STRIPE_SECRET_KEY must be at least 20 characters (Stripe sk_... format)'),
    /**
     * Optional API-version pin for the Stripe SDK. When set, every
     * outbound call locks to this version, defending against silent
     * shape shifts on a future SDK minor bump. Unpinned in local dev,
     * pinned in deployed environments per the runbook.
     */
    STRIPE_API_VERSION: z.string().min(1).optional(),
    /**
     * Return URL Stripe redirects the user to after the hosted
     * verification flow completes. Must be an absolute HTTPS URL in
     * staging / production. Local dev may use http://localhost for
     * the family / provider portal during development.
     *
     * The URL is passed verbatim to `verificationSessions.create`;
     * Stripe enforces its own URL-shape rules at the API boundary
     * (rejecting javascript:, data:, etc.). The minimum we enforce
     * here is "parseable URL" — a typo'd value fails fast at boot.
     */
    STRIPE_IDENTITY_RETURN_URL: z.string().url('STRIPE_IDENTITY_RETURN_URL must be a valid URL'),
    /**
     * Base64-encoded 32-byte (256-bit) symmetric key for AES-256-GCM
     * at-rest encryption of the Stripe verification_session payload
     * (`identity.kyc_records.payload_*`). The payload is a JSON blob
     * that may contain document-type metadata, the verified name, and
     * other PII Stripe surfaces back to us; we encrypt at rest so DB
     * write access alone cannot read it.
     *
     * INDEPENDENT key from `MFA_TOTP_ENC_KEY` so a leaked MFA cipher
     * key does not also grant the ability to read every KYC row, and
     * vice versa. Compartmentalisation matters — KYC payloads and
     * TOTP secrets are different sensitivity classes.
     *
     * Validated to decode to exactly 32 bytes so a misconfigured
     * override fails at boot, not at the first KYC enrollment in
     * production.
     */
    KYC_PAYLOAD_ENC_KEY: z
      .string()
      .min(1, 'KYC_PAYLOAD_ENC_KEY is required')
      .refine((value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      }, 'KYC_PAYLOAD_ENC_KEY must be a base64 string that decodes to exactly 32 bytes (AES-256 key)'),
    /**
     * Integer key version stored alongside each encrypted KYC payload.
     * Forward-compatible rotation: increment, encrypt new rows under
     * the new version, run a backfill worker to re-wrap legacy rows.
     * Phase 1 ships with version 1.
     */
    KYC_PAYLOAD_ENC_KEY_VERSION: z.coerce.number().int().positive().default(1),
    /**
     * Shared-secret header value the internal webhook-dispatch
     * endpoint (`POST /api/v1/internal/kyc/webhook-events`) pins.
     * service-webhook's `STRIPE_IDENTITY_DISPATCH_API_KEY` env carries
     * the same value and presents it on dispatch.
     *
     * Pre-TS-142 outbox-relay scaffolding. The route is anonymous in
     * the access-token sense (no user logs in to deliver a webhook
     * event) but pinned at the application layer to a constant the
     * caller must hold. Defence-in-depth alongside the TS-151
     * NetworkPolicy that restricts the route to in-cluster callers.
     * Minimum length 32 to make brute-force impractical even if the
     * NetworkPolicy is bypassed; the secrets manager generates these
     * at provision time.
     */
    KYC_WEBHOOK_INTERNAL_API_KEY: z
      .string()
      .min(32, 'KYC_WEBHOOK_INTERNAL_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // Recipient-contacts batch (TS-235). Internal
    // `POST /api/v1/internal/identity/recipient-contacts` endpoint the
    // wellness-summary worker calls to resolve user ids to email +
    // account status. Same shared-secret defence-in-depth pattern as
    // `KYC_WEBHOOK_INTERNAL_API_KEY` above and service-household's
    // `HOUSEHOLD_VISIT_PREP_INTERNAL_*` pair (TS-208): the route is
    // anonymous in the access-token sense (a worker, not a logged-in
    // user, calls it) but pinned at the application layer to a constant
    // the caller must hold. Defence-in-depth alongside the TS-151
    // NetworkPolicy that restricts the route to in-cluster callers.
    //
    //   - IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME — the HTTP header the
    //     caller presents the shared secret on. Configurable so the
    //     platform can rotate the header without a code change;
    //     defaults to the platform-standard `x-internal-api-key`.
    //   - IDENTITY_RECIPIENT_CONTACTS_API_KEY — the shared-secret value
    //     itself. REQUIRED (no default) so a misconfigured deployment
    //     fails fast at boot rather than shipping an unauthenticated
    //     internal route. Minimum length 32 to make brute-force
    //     impractical even if the NetworkPolicy is bypassed; the
    //     secrets manager generates these at provision time.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Header name the recipient-contacts internal route reads the
     * shared secret from. Configurable per the platform internal-route
     * convention; defaults to `x-internal-api-key`.
     */
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    /**
     * Shared-secret value the recipient-contacts internal route pins.
     * The wellness-summary worker holds the same value in its env and
     * presents it on every call. REQUIRED with a 32-char floor — see
     * the cluster comment above for the threat-model rationale.
     */
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: z
      .string()
      .min(32, 'IDENTITY_RECIPIENT_CONTACTS_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // Privacy-export contribution (TS-309b). Internal
    // `GET /api/v1/internal/privacy/export/:subjectKind/:subjectId` the
    // export-assembly job calls to collect identity's slice of a
    // data-subject export. Same shared-secret shape as the
    // recipient-contacts pair above.
    //
    // A SEPARATE secret from the recipient-contacts one on purpose: the
    // two routes hand out different things (a batch of emails vs
    // everything identity holds about one person) and are called by
    // different workloads, so one leaked value must not open both.
    // ───────────────────────────────────────────────────────────────────
    /**
     * Header name the privacy-export internal route reads the shared
     * secret from. Defaults to the platform-standard header.
     */
    IDENTITY_PRIVACY_EXPORT_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    /**
     * Shared-secret value the privacy-export internal route pins.
     * REQUIRED with a 32-char floor so a misconfigured deployment fails
     * at boot rather than serving a person's account history
     * unauthenticated.
     */
    IDENTITY_PRIVACY_EXPORT_API_KEY: z
      .string()
      .min(32, 'IDENTITY_PRIVACY_EXPORT_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // Observability (TS-020-followup-1). OpenTelemetry tracing +
    // Prometheus metrics surface backed by @taste-and-see/tracing. See
    // PDD §20.5 and CLAUDE.md §10. service-identity is the FIRST real
    // consumer of the shared tracing package; the env shape established
    // here is the pattern subsequent services mirror.
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
    super(`service-identity env validation failed: ${EnvValidationError.format(issues)}`);
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
