/**
 * Google Calendar port (TS-206) — the narrow interface the
 * `CalendarSyncService` depends on. The real `@googleapis/calendar`
 * adapter is the ONLY file in the codebase that imports the Google SDK
 * (ADR-0003); the rest of the service depends on this port, so unit
 * tests inject a fake and the SDK import stays isolated to one file.
 *
 * Every method takes the resolved `GoogleOAuthConfig` explicitly — the
 * adapter holds no env/state of its own, which keeps it a pure
 * translation layer and keeps the "is the feature configured?" decision
 * in `CalendarSyncService.resolveConfig()` (one place).
 */

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * Tokens returned from the authorization-code exchange. We persist ONLY
 * the refresh token (encrypted); access tokens are short-lived and
 * re-minted from the refresh token at sync time.
 */
export interface GoogleCalendarTokens {
  /** Long-lived offline refresh token. A secret — never logged. */
  readonly refreshToken: string;
  /** Granted scope string (space-separated). Null if Google omits it. */
  readonly scope: string | null;
  /**
   * Connected Google account email, decoded from the `openid email`
   * id_token claim. Low-sensitivity (the provider's own address). Null
   * when the id_token / claim is absent.
   */
  readonly accountEmail: string | null;
}

/** One opaque busy interval pulled from the free/busy API. */
export interface ExternalBusyInterval {
  readonly startAt: Date;
  readonly endAt: Date;
}

export interface GoogleCalendarPort {
  /**
   * Build the Google consent URL. Requests offline access + forced
   * consent (so a refresh token is always returned) + the free/busy +
   * `openid email` scopes. The `state` is our signed CSRF/identity token.
   */
  buildAuthorizationUrl(config: GoogleOAuthConfig, input: { readonly state: string }): string;

  /**
   * Exchange an authorization code for tokens. Throws
   * `GoogleCalendarError` when Google returns no refresh token (e.g. a
   * re-grant without forced consent) or the exchange fails.
   */
  exchangeCode(
    config: GoogleOAuthConfig,
    input: { readonly code: string },
  ): Promise<GoogleCalendarTokens>;

  /**
   * Query the provider's primary-calendar free/busy over `[timeMin,
   * timeMax)`. Re-mints an access token from the refresh token
   * internally. Throws `GoogleCalendarError` when the refresh token is
   * rejected (the provider revoked access / the grant expired) — the
   * caller maps this to the `error` connection status.
   */
  queryBusyIntervals(
    config: GoogleOAuthConfig,
    input: { readonly refreshToken: string; readonly timeMin: Date; readonly timeMax: Date },
  ): Promise<readonly ExternalBusyInterval[]>;

  /**
   * Best-effort revoke of the refresh token at Google. Called on
   * disconnect. Implementations swallow a revoke failure (the token may
   * already be invalid) — the disconnect proceeds regardless so a stale
   * Google-side grant never blocks the local cleanup.
   */
  revokeRefreshToken(
    config: GoogleOAuthConfig,
    input: { readonly refreshToken: string },
  ): Promise<void>;
}

/** DI token for the Google Calendar port. */
export const GOOGLE_CALENDAR_PORT = Symbol('GOOGLE_CALENDAR_PORT');

/**
 * Typed error thrown by the adapter for any Google-side failure
 * (token exchange, refresh rejection, free/busy query). `kind`
 * distinguishes the "the provider's grant is no longer valid"
 * (`auth_rejected` → connection moves to `error` + reconsent) case from
 * a transient transport failure (`transient`).
 */
export class GoogleCalendarError extends Error {
  constructor(
    public readonly kind: 'auth_rejected' | 'no_refresh_token' | 'transient',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`google-calendar ${kind}: ${message}`, options);
    this.name = 'GoogleCalendarError';
  }
}
