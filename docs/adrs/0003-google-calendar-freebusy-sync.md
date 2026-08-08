# ADR-0003 — Google Calendar free/busy sync via `@googleapis/calendar`

- **Status:** Accepted
- **Date:** 2026-05-29
- **Deciders:** Engineering (provider domain), with product sign-off on the library addition
- **Task:** TS-206 — External calendar sync (Google Calendar OAuth) for provider availability
- **Companion docs:** PRD §7.3; PDD §8.2, §29; CLAUDE.md §13 (approved libraries)

---

## Context

PRD §7.3 calls for provider calendar sync (Google / iCloud / Outlook) so a
provider's external commitments automatically subtract from the availability
the family portal surfaces. TS-206 lands the **Google** leg first; iCloud +
Outlook follow as siblings once the Google shape is stable (TS-206-followup-2).

The provider availability model (TS-203) already stores recurring weekly
windows (`provider_availability_windows`) + date-keyed blackouts
(`provider_availability_exceptions`). External calendar sync adds a **third,
read-only** input: busy intervals pulled from the provider's Google Calendar.
These intervals union with the existing two axes — a window occurrence that
overlaps an external busy block is treated as unavailable.

To talk to Google Calendar we need:

1. An **OAuth 2.0** authorization-code flow with an **offline** refresh token
   (so we can re-query free/busy on a schedule without the provider
   re-consenting each time).
2. The Google Calendar **`freebusy.query`** API to read busy intervals.

Neither capability is on the CLAUDE.md §13 approved-libraries list. Only
`@googlemaps/*` and `mapbox-sdk` are approved Google-adjacent clients, and
those cover Maps/Places, not Calendar or OAuth. CLAUDE.md §13 + §16 require an
explicit decision before adding a library.

## Decision

Adopt **`@googleapis/calendar`** (the scoped, single-API Google client) as the
sole new dependency for the Google Calendar leg, added to
`apps/service-provider` only.

`@googleapis/calendar` re-exports `google-auth-library`'s `OAuth2Client` via its
`auth` namespace, so one dependency covers **both** the OAuth flow and the
`freebusy.query` call — no separate `google-auth-library` or `googleapis`
umbrella dependency is needed.

### Why the scoped client over the `googleapis` umbrella

- **Smaller dependency surface.** `googleapis` bundles every Google API
  surface (~hundreds of generated clients); `@googleapis/calendar` ships only
  the Calendar v3 client + the shared `googleapis-common` / `google-auth-library`
  runtime. Smaller install, smaller attack surface, smaller image (PDD §20.1
  size budget).
- **One API, one client.** TS-206 needs Calendar free/busy and nothing else.
  Pulling the umbrella would import surfaces we never call.
- Matches the platform's "narrow dependency per need" posture.

### OAuth scopes (minimum-necessary)

- `https://www.googleapis.com/auth/calendar.freebusy` — read free/busy only.
  We never read event titles, attendees, locations, or descriptions; the
  busy/free boolean is all the availability union needs. This is the
  least-privilege scope for the feature and keeps us out of the
  sensitive-scope / annual-CASA-assessment tier that the `calendar.readonly`
  scope would drag in.
- `openid email` — to capture which Google account the provider connected, for
  display in the provider portal ("Connected as alex@gmail.com") and so a
  provider can tell which account they linked. The email is **low-sensitivity**
  (the provider's own account address); it is not in a special PII class.

### Security & data handling

- **Refresh token at rest is encrypted** (AES-256-GCM) under an
  **independent** key (`CALENDAR_TOKEN_ENC_KEY`), versioned for rotation —
  same envelope-cipher shape as the Checkr payload cipher (TS-051) and the KYC
  / MFA ciphers. A leaked calendar cipher key does not grant the ability to
  read any other encrypted column, and vice versa (CLAUDE.md §3.5
  compartmentalisation). The refresh token is a long-lived secret; it is
  **never logged** (CLAUDE.md §3.9 / §17.2).
- **CSRF + identity binding on the OAuth `state`.** The `state` parameter is an
  HMAC-SHA256-signed, TTL-bounded token carrying the `providerId` + actor +
  nonce, signed with `GOOGLE_CALENDAR_OAUTH_STATE_SECRET`. The unauthenticated
  callback (Google redirects the browser, carrying no access token) trusts the
  signed state as the identity + CSRF boundary; a forged or expired state is
  rejected before any token exchange.
- **Read-only busy mirror.** `provider_availability_external` is a derived,
  re-buildable cache of busy intervals. It carries **no** event content — only
  `(provider_id, source, starts_at, ends_at)`. Dropping + re-syncing it is
  always safe; the source of truth is Google.
- **TLS-only.** All Google calls go over the SDK's TLS transport; TLS
  verification is never disabled (CLAUDE.md §3.9 / §17.9).

### Feature-flag / configuration posture

The Google OAuth credentials + cipher key + state secret are **optional** env
on service-provider. When unset, the calendar-sync endpoints return `503
calendar_sync_not_configured` (the same "optional secret → 503" pattern used
for the gateway's internal shared secrets). This keeps the service bootable in
dev / CI without Google credentials and lets the feature ship dark behind the
absence of its config (CLAUDE.md §11 — every user-visible change ships behind a
flag; here the flag is "is the integration configured").

## Consequences

- **Positive:** one small dependency unlocks the whole Google leg; the OAuth +
  cipher + state patterns are reusable verbatim for the iCloud / Outlook
  siblings (TS-206-followup-2); the busy mirror is a safe, re-buildable cache.
- **Negative:** a new third-party client to keep patched (Trivy/Snyk in CI
  cover it); Google API quota + token-refresh-failure handling to operate
  (the `error` connection status + reconsent path, TS-206-followup-5).
- **Follow-ups carved from TS-206:**
  - `TS-206-followup-1` — gateway BFF proxy + web-provider "Calendar sync" UI.
  - `TS-206-followup-2` — iCloud (CalDAV) + Outlook (Microsoft Graph) siblings.
  - `TS-206-followup-3` — periodic background re-sync worker (BullMQ cron).
  - `TS-206-followup-4` — booking-svc availability gate consumes the external
    busy mirror (TS-060 / TS-204-followup-1 path).
  - `TS-206-followup-5` — token-refresh-failure → `error` status → reconsent
    prompt; refresh-token rotation/backfill worker.
  - `TS-206-followup-6` — Testcontainers integration + Playwright E2E.
  - `TS-206-followup-7` — sub-window-precision overlap (split a window around a
    short external busy block instead of dropping the whole occurrence) +
    true DST-edge calibration of the timezone overlap helper.
  - `TS-206-followup-8` — OpenTelemetry tracing + Prometheus metrics for the
    sync surface.

## Alternatives considered

- **`googleapis` umbrella** — rejected: pulls every Google API surface for a
  single-API need (see "Why the scoped client").
- **Raw REST via `fetch`** (no new dependency) — rejected: we'd hand-roll the
  OAuth token-exchange + refresh + retry/backoff that `google-auth-library`
  already implements correctly; more code, more security-sensitive surface to
  get wrong, for no dependency-surface win that matters at our scale.
- **Defer external sync entirely** — rejected: PRD §7.3 lists calendar sync as
  a provider-app requirement; the availability union is materially incomplete
  without it.
