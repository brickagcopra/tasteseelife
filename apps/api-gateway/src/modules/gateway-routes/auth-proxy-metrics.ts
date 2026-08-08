import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

const METER_NAME = 'api-gateway:auth-proxy';

/** Which pre-auth surface was called. Four routes, four literals. */
export type AuthProxySurface =
  | 'signup'
  | 'login'
  | 'refresh'
  | 'mfa-verify'
  // TS-309d-followup-1 — the lost-device second step. Belongs on this counter
  // rather than a new one for the same reason `mfa-verify` does: it is
  // pre-auth and it MINTS A SESSION. The authenticated enrol / confirm / list
  // / remove routes do neither, so they are deliberately not here.
  | 'mfa-recovery-verify'
  // TS-510 — the two email-verification surfaces. Pre-auth like the rest of
  // this counter, and they belong here for the operational reason: a spike in
  // `verify-email` `client_error` means links are expiring before users click
  // them, and a spike in `resend-verification` means the first mail is not
  // arriving. Both are read off the same dashboard as the login funnel because
  // that is the funnel they are part of.
  | 'verify-email'
  | 'resend-verification';

/**
 * How an auth-proxy call resolved.
 *
 * The first three are outcomes the HTTP status cannot express:
 *
 *   - `session` / `challenge` — **both are 200s.** `LoginResponseSchema` is a
 *     discriminated union: valid credentials on an MFA-enrolled account
 *     return a challenge, valid credentials without MFA return a session.
 *     Collapsing them loses the one number that says whether MFA enrolment
 *     is actually protecting logins, and a sudden collapse of `challenge`
 *     toward zero is what an MFA bypass would look like from the outside.
 *   - `invalid_request` — the gateway's own Zod check rejected the payload
 *     before any downstream call. A 400 from us and a 401 from identity are
 *     both "the caller failed"; only one of them means somebody is probing
 *     the shape of our API.
 *   - `contract_violation` — the downstream returned 200 with a body that
 *     does not match the contract, which the gateway renders as a 502. In
 *     the status series that is indistinguishable from a downstream 5xx,
 *     and it means something entirely different: gateway/identity deploy
 *     skew, not a failing service.
 *
 * The rest mirror `DownstreamResult`'s discriminant.
 */
export type AuthProxyOutcome =
  | 'session'
  | 'challenge'
  | 'ok'
  | 'invalid_request'
  | 'contract_violation'
  | 'client_error'
  | 'server_error'
  | 'timeout'
  | 'network_error'
  | 'not_configured';

/**
 * The auth-proxy instrument (TS-121-followup-9).
 *
 * `gateway_auth_proxy_total{surface,outcome}` — every call to the four
 * pre-auth routes, by what actually happened.
 *
 * **One counter with a `surface` label, not the three the task specified.**
 * The acceptance named `auth_proxy_signup_total`, `auth_proxy_login_outcome_total`
 * and `auth_proxy_refresh_total`; it was written before `mfa/verify` existed,
 * which is precisely the failure mode of per-surface counter names — the
 * fourth route lands and nobody adds the fourth counter. One counter with a
 * closed `surface` label is 4 × 10 = 40 series at the ceiling, filters to the
 * per-route view in one PromQL selector, and makes a fifth surface a single
 * argument rather than a new instrument nobody remembers to dashboard.
 *
 * **Not redundant with `gateway_downstream_calls_total{service='identity'}`**
 * (TS-140-followup-4), which counts the CALL. This counts the AUTHENTICATION.
 * A login that returns a challenge and a login that returns a session are one
 * and the same `ok` call to identity.
 *
 * **No email, no user id, no token, no IP** — the labels are two closed
 * enums and nothing else. This is the surface where a careless label would
 * put a credential-adjacent identifier into a metrics backend that
 * replicates far wider than the auth logs do (CLAUDE.md §10, §17.2).
 *
 * Instruments come from `getMeter`, a usable no-op when `initMetrics` was
 * never called — safe to construct in unit tests without booting the SDK.
 */
@Injectable()
export class AuthProxyMetrics {
  private readonly calls: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.calls = meter.createCounter('gateway_auth_proxy_total', {
      description:
        'Total gateway pre-auth proxy calls, by surface (signup / login / refresh / mfa-verify) and outcome.',
    });
  }

  /** Record one auth-proxy call. */
  recordCall(surface: AuthProxySurface, outcome: AuthProxyOutcome): void {
    this.calls.add(1, { surface, outcome });
  }
}

/**
 * Read the contract's own outcome discriminator off a validated response
 * body, falling back to `ok`.
 *
 * `LoginResponseSchema` names its two branches `session` and `challenge`;
 * `SignupResponseSchema` has no such field. Rather than special-casing the
 * login route, the mapper asks the parsed body what it is — so a future
 * surface whose contract grows an `outcome` discriminator is measured
 * correctly without touching this file.
 *
 * Only the two known literals are honoured. An unrecognised discriminator
 * degrades to `ok` rather than becoming a label: a body field, even a
 * validated one, must not be able to mint metric series.
 */
export function outcomeFromBody(body: unknown): AuthProxyOutcome {
  if (typeof body !== 'object' || body === null) return 'ok';
  const outcome = (body as { outcome?: unknown }).outcome;
  if (outcome === 'session' || outcome === 'challenge') return outcome;
  return 'ok';
}
