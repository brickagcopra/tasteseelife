import { SPONSORED_LISTINGS_LIMIT_MAX } from '@taste-and-see/contracts';
import { z } from 'zod';

/**
 * Environment-variable schema for service-search.
 *
 * Validated once at bootstrap. Failure aborts the process with a
 * structured error rather than silently falling back to defaults —
 * fail-fast keeps misconfigured deployments out of the request path
 * (CLAUDE.md §17.11).
 *
 * Clusters of env shipping with TS-111:
 *
 *   - Skeleton — `PORT`, `LOG_LEVEL`, `NODE_ENV`, `SERVICE_VERSION`.
 *
 *   - Database — `DATABASE_URL` (TS-211). service-search owns the
 *     `search` Postgres schema (`search_ranking_config` row family).
 *     Phase 1 reads / writes the per-region tier-weight rows the
 *     ranking layer consumes at query time.
 *
 *   - Public-search auth — `JWT_ACCESS_SECRET` / `JWT_ISSUER` /
 *     `JWT_AUDIENCE`. service-search verifies access tokens minted by
 *     service-identity for the family-portal discovery surface. (The
 *     internal upsert / delete surfaces use a separate shared-secret
 *     header below.)
 *
 *   - Elasticsearch backend — `ELASTICSEARCH_NODE_URL` (optional;
 *     absence forces stub mode), `ELASTICSEARCH_USERNAME` /
 *     `ELASTICSEARCH_PASSWORD` (optional), `ELASTICSEARCH_API_KEY`
 *     (optional alternative to user/pass), `ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED`
 *     (defaults `true` — CLAUDE.md §3.9 bans disabling TLS verification),
 *     `SEARCH_PROVIDER_INDEX_NAME` (default `providers_v1`). Phase-1
 *     stub mode is the default; live wiring lands TS-111-followup-1.
 *
 *   - Tier-boost ranking FALLBACKS — `SEARCH_TIER_BOOST_BASIC` /
 *     `..._CERTIFIED` / `..._ELITE`. Per PDD §14.1 tier-aware boosting
 *     (Elite > Certified > Basic). Float multipliers.
 *
 *     **TS-211 changes the source of truth** to the
 *     `search.search_ranking_config` Postgres table — service-search's
 *     ranking layer reads the resolved per-region weights from
 *     `RankingConfigService.resolveWeights(...)` at query time. These
 *     env vars survive as the boot-time fallback used when the DB row
 *     is absent or the cache miss path can't reach Postgres. Defaults
 *     match the seeded `global` row: Basic 1.0 / Certified 1.2 /
 *     Elite 1.5.
 *
 *   - Geo-distance decay (TS-210) — `SEARCH_GEO_DECAY_SCALE_KM`. The
 *     e-folding length (km) of the exponential distance decay folded
 *     into a hit's relevance score when a search supplies a geo center.
 *     Default `40.2336` km (25 miles). Resolved alongside the tier
 *     weights via `RankingConfigService.resolveWeights(...)`.
 *
 *   - Internal index ingest — `SEARCH_INDEX_HEADER_NAME` /
 *     `SEARCH_INDEX_API_KEY`. The TS-053 search-indexer worker pins
 *     these on every PUT / DELETE to the internal surface. The same
 *     header / secret pair pins the TS-211 internal ranking-config
 *     admin endpoints. TS-151 NetworkPolicy will restrict the route to
 *     in-cluster callers; the header is application-layer
 *     defence-in-depth.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    /**
     * Default port `3020`: identity = 3010, household = 3011,
     * subscription = 3012, webhook = 3013, provider = 3014,
     * booking = 3015, audit = 3016, notification = 3017,
     * payouts = 3018, media = 3019. service-search takes the next-
     * available port so the local dev runbook stays predictable.
     */
    PORT: z.coerce.number().int().positive().default(3020),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    SERVICE_VERSION: z.string().default('dev'),

    // ───────────────────────────────────────────────────────────────────
    // TS-211 — Postgres datasource. service-search owns the `search`
    // schema; `search.search_ranking_config` carries the per-region
    // tier-weight rows the ranking layer consumes at query time.
    // ───────────────────────────────────────────────────────────────────

    DATABASE_URL: z
      .string()
      .url('DATABASE_URL must be a valid URL (postgresql://user:pass@host:port/db)'),

    // ───────────────────────────────────────────────────────────────────
    // TS-111 — JWT access-token verification. service-search consumes
    // JWTs minted by service-identity for the public-search surface.
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
    // TS-111 — Elasticsearch backend. When the node URL is absent the
    // service runs in stub mode (in-memory pure-TS index). Live SDK
    // wiring lands TS-111-followup-1.
    // ───────────────────────────────────────────────────────────────────

    ELASTICSEARCH_NODE_URL: z
      .string()
      .url('ELASTICSEARCH_NODE_URL must be a valid URL when present')
      .optional(),
    ELASTICSEARCH_USERNAME: z.string().min(1).optional(),
    ELASTICSEARCH_PASSWORD: z.string().min(1).optional(),
    ELASTICSEARCH_API_KEY: z.string().min(1).optional(),
    /**
     * TLS-cert verification toggle. Default `true`; CLAUDE.md §3.9 bans
     * disabling TLS verification, so the value `false` is REJECTED in
     * `production` mode regardless of how it's set (see the
     * `.superRefine` below).
     */
    ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED: z
      .union([z.literal('true'), z.literal('false')])
      .transform((value) => value === 'true')
      .default('true'),
    SEARCH_PROVIDER_INDEX_NAME: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/, 'index name must be lower-case alphanumeric / _ / -')
      .default('providers_v1'),

    // ───────────────────────────────────────────────────────────────────
    // TS-111 / TS-211 — Tier-boost ranking weight FALLBACKS (PDD §14.1).
    //
    // The source of truth is the `search.search_ranking_config` Postgres
    // table — `RankingConfigService.resolveWeights(...)` reads the
    // per-region row at query time. These env vars are the boot-time
    // fallback used when the DB row is absent or the cache miss path
    // can't reach Postgres. Defaults match the TS-211 seeded `global`
    // row spec: Basic 1.0 / Certified 1.2 / Elite 1.5.
    // ───────────────────────────────────────────────────────────────────

    SEARCH_TIER_BOOST_BASIC: z.coerce.number().positive().default(1.0),
    SEARCH_TIER_BOOST_CERTIFIED: z.coerce.number().positive().default(1.2),
    SEARCH_TIER_BOOST_ELITE: z.coerce.number().positive().default(1.5),

    // ───────────────────────────────────────────────────────────────────
    // TS-210 — Geo-distance decay scale (PDD §14.1 geo-distance scoring).
    //
    // The characteristic length (e-folding distance, km) of the
    // exponential distance decay the ranking layer folds into a hit's
    // relevance score when a search supplies a geo center: a provider's
    // score is multiplied by `exp(-distanceKm / scale)`, so it is
    // unchanged at distance 0 and decays to `1/e` (~0.368) at one scale
    // length. Default `40.2336` km = 25 miles (PRD §6.3 family-portal
    // local-discovery radius).
    //
    // **Configurability.** Env-sourced today and surfaced through
    // `RankingConfigService.resolveWeights(...)` alongside the tier
    // weights so the backend reads one resolved config object. Moving
    // the scale into a per-region `search.search_ranking_config` column
    // (so ops can tune decay per market) pairs with the region-resolution
    // follow-up (TS-211-followup-3); until then this env var is the
    // single source.
    // ───────────────────────────────────────────────────────────────────

    SEARCH_GEO_DECAY_SCALE_KM: z.coerce.number().positive().default(40.2336),

    // ───────────────────────────────────────────────────────────────────
    // TS-111 — Internal index-ingest shared secret. TS-053 search-indexer
    // worker posts each upsert / delete here with this header.
    // ───────────────────────────────────────────────────────────────────

    SEARCH_INDEX_HEADER_NAME: z.string().min(1).default('x-internal-api-key'),
    SEARCH_INDEX_API_KEY: z.string().min(32, 'SEARCH_INDEX_API_KEY must be at least 32 characters'),

    // ───────────────────────────────────────────────────────────────────
    // TS-217-prep-1 — Outbox producer. service-search owns a
    // `search.outbox_events` table the `@taste-and-see/nest-outbox` SDK
    // appends `search.performed` rows to (best-effort, off the search
    // read path — see `SearchAnalyticsEmitter`). This value is stamped
    // on the `producer_service` column of every appended row so the
    // relay's per-service observability surfaces "which service emitted
    // this event". Mirrors service-booking / service-subscription.
    // ───────────────────────────────────────────────────────────────────

    OUTBOX_PRODUCER_SERVICE: z.string().min(1).default('service-search'),

    // ───────────────────────────────────────────────────────────────────
    // TS-218b — sponsored-listings resolve (service-ads, TS-218a).
    //
    // The provider-search results page reserves up to N top slots for
    // sponsored providers. service-search resolves them by POSTing the
    // ranked organic candidate ids + a derived audience to service-ads'
    // internal `sponsored-listings/resolve` surface, pinned by a shared
    // secret (mirrors the `SEARCH_INDEX_*` pin the search-indexer uses).
    //
    // **Entirely OPTIONAL + gated.** Sponsored resolution is enabled ONLY
    // when `ADS_SERVICE_BASE_URL` is set (see `isSponsoredListingsEnabled`).
    // Absent — the Phase-1 default, since service-ads has no k8s base yet —
    // the search path degrades to organic-only with no sponsored rows
    // (best-effort, like the `search.performed` analytics emit). When the
    // base URL IS set, `ADS_INTERNAL_API_KEY` (≥32 chars) becomes required
    // (the `.superRefine` below). `SEARCH_SPONSORED_SLOTS` (N, default 2),
    // `ADS_INTERNAL_HEADER_NAME` (default `x-internal-api-key`), and
    // `ADS_RESOLVE_TIMEOUT_MS` (default 750 ms) carry their fallbacks in
    // `SponsoredListingsClient` rather than as Zod defaults, so the fields
    // stay genuinely optional (no Zod default forces them into the `Env`
    // shape, keeping the gating cleanly URL-driven).
    // ───────────────────────────────────────────────────────────────────

    ADS_SERVICE_BASE_URL: z
      .string()
      .url('ADS_SERVICE_BASE_URL must be a valid URL when present')
      .optional(),
    ADS_INTERNAL_HEADER_NAME: z.string().min(1).optional(),
    ADS_INTERNAL_API_KEY: z
      .string()
      .min(32, 'ADS_INTERNAL_API_KEY must be at least 32 characters')
      .optional(),
    SEARCH_SPONSORED_SLOTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(SPONSORED_LISTINGS_LIMIT_MAX)
      .optional(),
    ADS_RESOLVE_TIMEOUT_MS: z.coerce.number().int().positive().max(5000).optional(),

    // ───────────────────────────────────────────────────────────────────
    // TS-111-followup-4 — OpenTelemetry tracing + Prometheus metrics knobs
    // (PDD §20.5, CLAUDE.md §10). The OTel SDK is booted by the first-line
    // `src/observability/bootstrap.ts` shim, which reads these straight off
    // `process.env` (Zod validation runs further down the boot path). They
    // are re-declared here — with the same coercion shape as every other
    // service (service-webhook / service-identity / service-provider /
    // service-media) — so a configured pod still validates rather than
    // having the values silently stripped by the `.strict()` key filter,
    // and so `main.ts` can log the resolved flags.
    // ───────────────────────────────────────────────────────────────────

    /**
     * Toggle OTel tracing init. Defaults true; flip to false to
     * short-circuit `initTracing` (e.g. CI runs that don't ship spans to a
     * collector). Consulted at boot, before any service module loads.
     */
    OTEL_TRACES_ENABLED: z
      .union([z.boolean(), z.string()])
      .default(true)
      .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true')),
    /**
     * Toggle OTel metrics init. Same coercion shape as
     * `OTEL_TRACES_ENABLED`. The `/metrics` scrape endpoint stays wired
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
     * env vars and ultimately `http://localhost:4318/v1/traces`. Re-declared
     * here with `.url()` so a typo fails boot rather than surfacing as a
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
  .strict()
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED'],
        message:
          'ELASTICSEARCH_TLS_REJECT_UNAUTHORIZED=false is forbidden in production (CLAUDE.md §3.9)',
      });
    }
    // TS-218b — a configured sponsored-resolve target without its shared
    // secret is a misconfiguration, not a silent no-auth call.
    if (env.ADS_SERVICE_BASE_URL !== undefined && env.ADS_INTERNAL_API_KEY === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADS_INTERNAL_API_KEY'],
        message:
          'ADS_INTERNAL_API_KEY is required when ADS_SERVICE_BASE_URL is set (the sponsored-listings resolve shared secret)',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: z.ZodIssue[]) {
    super(`service-search env validation failed: ${EnvValidationError.format(issues)}`);
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
 * Backend runs in stub mode when no Elasticsearch node URL is supplied.
 * Exposed as a helper so every caller (SearchBackend provider + tests +
 * admin tooling) reads the same predicate.
 */
export function isSearchBackendStubMode(env: Env): boolean {
  return env.ELASTICSEARCH_NODE_URL === undefined;
}

/**
 * Sponsored-listings resolve (TS-218b) is enabled only when the service-ads
 * base URL is configured. Absent → the search path skips the resolve and
 * returns organic-only results (no sponsored slots) — a best-effort degrade,
 * never a search failure. The env `.superRefine` guarantees the shared
 * secret is present whenever this returns true.
 */
export function isSponsoredListingsEnabled(env: Env): boolean {
  return env.ADS_SERVICE_BASE_URL !== undefined;
}
