import { resolve } from 'node:path';

import { REPO_ROOT } from './repo-env';

/**
 * The fleet the E2E suite starts, and the rules that govern it (TS-505).
 *
 * **Topology mirrors production.** Specs talk to the api-gateway and nothing
 * else. Services do not call one another (verified during TS-505 scoping:
 * `service-booking` holds no cross-service HTTP client) — the gateway is the
 * aggregator, and it is what mints the signed `x-ts-actor-*` trust headers
 * every downstream verifies. A suite that called `service-identity` directly
 * would skip the edge that authenticates, rate-limits, re-validates every
 * response shape, and signs the actor envelope, which is most of what could
 * break between two green unit suites.
 *
 * **One database, one schema per service.** Phase 1 puts every bounded
 * context in its own Postgres *schema* inside a single database (see any
 * service's `datasource db { schemas = [...] }`, and `OUTBOX_SOURCES` in
 * `.env.example`, which names outbox tables as `schema.table` across services
 * — the relay reads them all on one connection). The E2E fleet reproduces
 * that exactly, in a dedicated database so a run can drop and rebuild it
 * without touching a developer's local data.
 *
 * **Ports are the services' own declared defaults**, matching the
 * `{NAME}_SERVICE_BASE_URL` values in `.env.example` verbatim so no URL
 * rewriting is needed. They are still stated explicitly here rather than
 * being left to each schema's default: the fleet's wiring should be readable
 * in one place, and a default that drifts should break the port assertion in
 * `packages/testing/src/boot/service-ports.test.ts` rather than silently
 * relocate the suite.
 */

/** The dedicated database the E2E fleet runs against. Never `tastesee`. */
export const E2E_DATABASE_NAME = 'tastesee_e2e';

/** Where specs point. The gateway is the only surface a spec may touch. */
export const GATEWAY_PORT = 3000;
export const GATEWAY_BASE_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

/**
 * Header carrying the shared secret on every cluster-internal route.
 *
 * Each service names its own env var for this (`SEARCH_INDEX_HEADER_NAME`,
 * `BOOKING_TIER_DISPATCH_HEADER_NAME`, …) and every one of them defaults to
 * the same value. Pinned explicitly per fleet member rather than relied upon:
 * the harness has to send *some* header name, and deriving it from a default
 * that could drift in one service would produce a 401 whose cause is in a
 * different file from the failure.
 */
export const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';

/**
 * TOTP step length the fleet's `service-identity` runs with (TS-505d1).
 *
 * The shipped default is 30s. **Every staff account the suite mints spends two
 * codes** — one to confirm the enrolment, one to answer the login challenge —
 * and `mfa_methods.last_used_step` refuses the second if it falls in the same
 * step as the first. The harness therefore has to wait out a step boundary,
 * and at 30s that is up to half a minute per admin account, on a suite that
 * will grow an admin spec for every one of ~40 admin surfaces.
 *
 * Shortened, not disabled — the same class of override as the rate-limit
 * maxima below. Enrolment, the challenge, the replay watermark and the skew
 * window all still run; only the constant they are measured in is smaller, and
 * RFC 6238 §4 leaves the period to the deployment. Exported so the harness
 * generates codes against the value the service is actually running with: two
 * copies of a period is a suite that fails with `invalid code` and no clue why.
 */
export const FLEET_TOTP_PERIOD_SECONDS = 5;

export interface FleetService {
  /**
   * The member's label — used in logs, in the log file name, and as the key
   * for its seed script. Unique across the fleet.
   *
   * Also its directory under `apps/`, unless `path` says otherwise.
   */
  readonly dir: string;
  /**
   * Repo-relative workspace directory, when it is not `apps/{dir}`.
   *
   * The workers live under `apps/workers/`, and `dir` cannot simply carry the
   * nested path: it names a log file, and `test-results/fleet/workers/x.log`
   * would need a directory the harness does not create. Two fields keep the
   * label flat and the path accurate (TS-505d2).
   */
  readonly path?: string;
  /** TCP port the process listens on. */
  readonly port: number;
  /**
   * The Postgres schema this service owns, or `null` when it owns no schema
   * (the gateway is a pure BFF — PDD §7.1 — and has no `DATABASE_URL`).
   * A non-null value means `prisma migrate deploy` runs for it during setup.
   */
  readonly ownsSchema: string | null;
  /**
   * Per-service environment applied on top of `.env.example`. Keep this to
   * values that are genuinely environment-specific; anything a service needs
   * unconditionally belongs in `.env.example`, where TS-504's check keeps it
   * honest.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Services started for every run, in start order.
 *
 * Downstreams come first so the gateway's readiness probe reports them as
 * reachable on its first poll. The gateway boots fine without them (all the
 * `*_SERVICE_BASE_URL` entries but subscription's are optional), but a fleet
 * that starts back-to-front produces a first-run log full of connection
 * errors that mean nothing, which trains everyone to ignore the logs.
 *
 * This list grows one slice at a time. Each added service brings its own
 * migrations and its own seed step, and an entry here is a claim that the
 * suite actually exercises it — a service listed but never reached is fleet
 * start-up cost with no coverage.
 */
export const FLEET: readonly FleetService[] = [
  {
    dir: 'service-identity',
    port: 3010,
    ownsSchema: 'identity',
    env: {
      // The shipped default is `true` (production-first, defence in depth).
      // The suite speaks plain HTTP to 127.0.0.1, and a `Secure` cookie is
      // not returned to an `http://` origin — the refresh-rotation spec
      // would fail on transport, not on behaviour. The service's own
      // doc-block names local HTTP as exactly this override's purpose.
      REFRESH_COOKIE_SECURE: 'false',
      // Background sweeps (RBAC role expiry, overdue-DSAR) open Redis and
      // tick on a timer. They are covered by their own unit suites; here
      // they only add non-determinism and log noise to every run.
      RBAC_REVOKER_ENABLED: 'false',
      PRIVACY_OVERDUE_SWEEP_ENABLED: 'false',
      // See the gateway's note below — same reasoning, per-IP login breaker.
      LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW: '10000',
      // See `FLEET_TOTP_PERIOD_SECONDS`.
      MFA_TOTP_PERIOD_SECONDS: String(FLEET_TOTP_PERIOD_SECONDS),
    },
  },
  {
    dir: 'service-search',
    port: 3020,
    ownsSchema: 'search',
    env: {
      // `ELASTICSEARCH_NODE_URL` is deliberately absent from `.env.example`,
      // which is what selects `InMemorySearchBackend` (PDD §14.1 Phase 1).
      // Stated here so the choice is visible in the fleet rather than being
      // an inference from a missing key: the suite runs no OpenSearch, and a
      // day when one is required should break here, loudly.
      SEARCH_INDEX_HEADER_NAME: INTERNAL_API_KEY_HEADER,
    },
  },
  {
    dir: 'service-booking',
    port: 3027,
    ownsSchema: 'booking',
    env: {
      // **The tier gate is only observable in `enforce`.** The shipped
      // default is `advisory` (TS-064) — a rollout stance taken while the
      // snapshot cache hydrates, under which a §12 violation is logged and
      // the booking proceeds. `advisory` is a deployment decision; the rule
      // CLAUDE.md §12 states ("Tier 3 Concierge clients can only book Elite
      // Concierge providers, enforced at the booking-svc layer") is what the
      // spec asserts, and it has exactly one observable form.
      BOOKING_TIER_GATING_MODE: 'enforce',
      // Same reasoning as identity's sweeps: the anomaly detectors open
      // Redis and tick on a timer, they are covered by their own suites
      // (TS-308a / TS-308c), and here they only add non-determinism — a
      // sweep that opens a trust & safety incident mid-run would place a
      // booking hold on a subject a later spec is about to book.
      BOOKING_ANOMALY_DETECTION_ENABLED: 'false',
      BOOKING_TIER_DISPATCH_HEADER_NAME: INTERNAL_API_KEY_HEADER,
    },
  },
  {
    // **The household directory — and the only thing on the platform that
    // knows which households a user may act in** (TS-505d2-followup-5).
    // The api-gateway calls its internal memberships route on every
    // authenticated request to establish the request's household
    // `tenantScope`; without this member in the fleet the gateway resolves
    // nothing and every household-scoped surface refuses, which is exactly
    // the state the platform shipped in.
    dir: 'service-household',
    port: 3011,
    ownsSchema: 'household',
    // **No header-name override**, deliberately, unlike search and booking
    // above. Both sides of this pair default to
    // `x-household-memberships-internal-api-key`, and pinning only one of
    // them to `INTERNAL_API_KEY_HEADER` is exactly the mistake that was
    // made here first: the gateway kept its default, service-household
    // expected the override, and every lookup 401'd. The failure was
    // invisible in the response — the resolver fails CLOSED, so the request
    // simply stayed `global` and the surface refused with the same 400 it
    // has always returned. Only the gateway's WARN line named it.
  },
  {
    // Concierge — nine of the thirteen handlers TS-505d2-followup-5 unblocked
    // live here (assignments, emergency, enrichment ×2, onboarding, tickets
    // ×2), and not one of them had ever been reached by a running process.
    dir: 'service-concierge',
    port: 3021,
    ownsSchema: 'concierge',
    // `PAGERDUTY_ROUTING_KEY` is deliberately unset (it is `.optional()`).
    // The emergency path pages on-call best-effort and logs
    // `skipped_unconfigured` at WARN when it cannot — which is the shipped
    // Phase-1 posture (see the concierge k8s base), and a suite that paged a
    // real rotation would be a worse defect than the one it was written to
    // catch.
  },
  {
    // Trust & safety. Here for the family "report a concern" path
    // (TS-301a/b), which is the shortest gateway-reachable surface that
    // reads the household tenant scope and refuses without one — so it is
    // the honest end-to-end proof that the scope now arrives.
    dir: 'service-trust-safety',
    port: 3026,
    ownsSchema: 'trust_safety',
  },
  {
    // The §3.6 append-only audit trail. Five services emit
    // `audit.action_recorded` in-transaction with the mutation they
    // describe, and until TS-505d2 fixed the consumer bootstrap, not one
    // had ever landed — a compliance control that was silently empty.
    dir: 'service-audit',
    port: 3016,
    ownsSchema: 'audit',
  },
  {
    dir: 'service-accounting',
    port: 3015,
    ownsSchema: 'accounting',
    // Nothing to override. The outbox consumer starts unconditionally —
    // there is no enable flag, and there should not be one: a deployment
    // where the ledger silently stops consuming completions is not a mode
    // anyone wants to be able to select. Its cadence knobs
    // (`OUTBOX_CONSUMER_POLL_*`) are left at their shipped defaults so the
    // money-path spec's wait budget is measured against production timing.
  },
  {
    // **The first worker the suite runs**, and the first fleet member outside
    // `apps/`. Without it the outbox is a table nobody drains: service-booking
    // commits `booking.completed` in the same transaction as the check-out
    // (PDD §7.3) and service-accounting consumes it off a Redis Stream, and
    // the hop between those two is a separate process that had never run in a
    // test.
    dir: 'worker-outbox-relay',
    path: 'apps/workers/outbox-relay',
    port: 3050,
    ownsSchema: null,
    env: {
      // **Narrowed to the schemas this fleet migrates.** `.env.example` names
      // nine outbox tables and the relay interpolates each into raw SQL, so a
      // source whose schema is absent is a query error on every poll — the
      // relay logs an error a second and relays nothing from it.
      //
      // `search.outbox_events` exists but is deliberately absent, matching
      // `.env.example`: nothing consumes search's click/analytics events yet
      // (TS-505d2-followup-1). The three listed here are the ones the money
      // path travels plus the two whose producers are live.
      OUTBOX_SOURCES:
        'identity.outbox_events,booking.outbox_events,accounting.outbox_events,trust_safety.outbox_events',
      // The shipped 1s is a production trade-off between bus latency and
      // database load. Here the only reader is one spec waiting on one row,
      // and a tighter poll takes seconds off its budget without changing
      // anything the spec asserts.
      POLL_INTERVAL_MS: '250',
    },
  },
  {
    dir: 'api-gateway',
    port: GATEWAY_PORT,
    ownsSchema: null,
    env: {
      // The whole suite arrives from 127.0.0.1 inside a few minutes, so the
      // shipped `sensitive` policy (20 requests / 5 min, the login + signup
      // circuit breaker) would throttle the suite against itself and every
      // failure after the twentieth call would read as a 429 rather than the
      // defect under test. Raised, not disabled — the guard still runs on
      // every request, so a route that forgets `@UseGuards(RateLimitGuard)`
      // is still visible. The limiter's own behaviour (window arithmetic,
      // policy selection, Redis key namespacing) is covered by the gateway's
      // unit suite; asserting a 429 here would need a second gateway with a
      // tight policy, which is a separate slice.
      RATE_LIMIT_SENSITIVE_MAX_REQUESTS: '10000',
      RATE_LIMIT_DEFAULT_MAX_REQUESTS: '100000',
    },
  },
] as const;

/** Absolute path to a fleet member's workspace directory. */
export function serviceDir(service: FleetService): string {
  return resolve(REPO_ROOT, service.path ?? `apps/${service.dir}`);
}

/** Postgres URL for the E2E database, derived from `.env.example`'s. */
export function e2eDatabaseUrl(baseDatabaseUrl: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${E2E_DATABASE_NAME}`;
  return url.toString();
}

/**
 * Admin URL used to drop/create the E2E database. Points at the always-present
 * `postgres` maintenance database — you cannot drop the database you are
 * connected to.
 */
export function adminDatabaseUrl(baseDatabaseUrl: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
}
