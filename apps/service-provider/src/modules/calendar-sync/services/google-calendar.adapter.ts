import { Injectable, Logger } from '@nestjs/common';
import { auth, calendar } from '@googleapis/calendar';
import { withSpan } from '@taste-and-see/tracing';

import {
  GoogleCalendarError,
  type ExternalBusyInterval,
  type GoogleCalendarPort,
  type GoogleCalendarTokens,
  type GoogleOAuthConfig,
} from './google-calendar.port';

/**
 * Real Google Calendar adapter (TS-206). The **only** file in the
 * codebase that imports `@googleapis/calendar` (ADR-0003). It is a pure
 * translation layer between the `GoogleCalendarPort` interface and the
 * Google SDK — it holds no env / state of its own; the resolved OAuth
 * config arrives per-call from `CalendarSyncService.resolveConfig()`.
 *
 * `@googleapis/calendar` re-exports `google-auth-library`'s OAuth2 client
 * via its `auth` namespace, so this single dependency covers BOTH the
 * OAuth flow and the `freebusy.query` call.
 *
 * **Scopes** (minimum-necessary, ADR-0003):
 *   - `calendar.freebusy` — read free/busy ONLY. We never read event
 *     titles, attendees, locations, or descriptions.
 *   - `openid email` — capture which account was linked (display only).
 *
 * **Refresh token is a secret** — never logged (CLAUDE.md §3.9 / §17.2).
 * Error logs carry only the failure kind, never the token / code.
 */
@Injectable()
export class GoogleCalendarAdapter implements GoogleCalendarPort {
  private readonly logger = new Logger(GoogleCalendarAdapter.name);

  private static readonly SCOPES: readonly string[] = [
    'https://www.googleapis.com/auth/calendar.freebusy',
    'openid',
    'email',
  ];

  buildAuthorizationUrl(config: GoogleOAuthConfig, input: { readonly state: string }): string {
    const client = this.makeClient(config);
    return client.generateAuthUrl({
      // `offline` → Google returns a refresh token; `consent` forces the
      // consent screen every time so a refresh token is ALWAYS returned
      // (Google omits it on a silent re-grant otherwise).
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: false,
      scope: [...GoogleCalendarAdapter.SCOPES],
      state: input.state,
    });
  }

  async exchangeCode(
    config: GoogleOAuthConfig,
    input: { readonly code: string },
  ): Promise<GoogleCalendarTokens> {
    // TS-206-followup-8 — trace the outbound token-exchange network hop.
    // The recorded exception (on throw) carries only the GoogleCalendarError
    // message — never the code or the returned token (CLAUDE.md §3.9 / §17.2).
    return withSpan('provider.calendar.google.exchange_code', async () => {
      const client = this.makeClient(config);
      let refreshToken: string | null | undefined;
      let scope: string | null | undefined;
      let idToken: string | null | undefined;
      try {
        const { tokens } = await client.getToken(input.code);
        refreshToken = tokens.refresh_token;
        scope = tokens.scope;
        idToken = tokens.id_token;
      } catch (err) {
        throw new GoogleCalendarError('transient', 'authorization-code exchange failed', {
          cause: err,
        });
      }
      if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
        // No refresh token means we can't re-sync offline — treat as a
        // hard failure so the provider re-consents (we force prompt=consent
        // on the auth URL precisely to avoid this, so it indicates a
        // malformed grant).
        throw new GoogleCalendarError('no_refresh_token', 'Google returned no refresh token');
      }
      return {
        refreshToken,
        scope: typeof scope === 'string' ? scope : null,
        accountEmail: decodeIdTokenEmail(idToken),
      };
    });
  }

  async queryBusyIntervals(
    config: GoogleOAuthConfig,
    input: { readonly refreshToken: string; readonly timeMin: Date; readonly timeMax: Date },
  ): Promise<readonly ExternalBusyInterval[]> {
    // TS-206-followup-8 — trace the outbound free/busy network hop. Only
    // opaque busy intervals are read (never event titles / attendees), and
    // the recorded exception carries only the GoogleCalendarError message.
    return withSpan('provider.calendar.google.query_busy', async () => {
      const client = this.makeClient(config);
      client.setCredentials({ refresh_token: input.refreshToken });
      const cal = calendar({ version: 'v3', auth: client });

      let busy: ReadonlyArray<{ start?: string | null; end?: string | null }>;
      try {
        const response = await cal.freebusy.query({
          requestBody: {
            timeMin: input.timeMin.toISOString(),
            timeMax: input.timeMax.toISOString(),
            items: [{ id: 'primary' }],
          },
        });
        busy = response.data.calendars?.primary?.busy ?? [];
      } catch (err) {
        throw new GoogleCalendarError(classifyGoogleError(err), 'free/busy query failed', {
          cause: err,
        });
      }

      const intervals: ExternalBusyInterval[] = [];
      for (const slot of busy) {
        if (typeof slot.start !== 'string' || typeof slot.end !== 'string') continue;
        const startAt = new Date(slot.start);
        const endAt = new Date(slot.end);
        if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) continue;
        if (endAt <= startAt) continue;
        intervals.push({ startAt, endAt });
      }
      return intervals;
    });
  }

  async revokeRefreshToken(
    config: GoogleOAuthConfig,
    input: { readonly refreshToken: string },
  ): Promise<void> {
    // TS-206-followup-8 — trace the best-effort revoke hop. The revoke
    // failure is swallowed (the span ends OK) so a stale Google-side grant
    // never blocks the local disconnect; the token is never logged.
    await withSpan('provider.calendar.google.revoke', async () => {
      const client = this.makeClient(config);
      try {
        await client.revokeToken(input.refreshToken);
      } catch (err) {
        // Best-effort — the token may already be invalid (the provider
        // revoked on Google's side). The local disconnect proceeds
        // regardless; we log at warn without the token.
        this.logger.warn(
          { kind: classifyGoogleError(err) },
          'google-calendar.revoke best-effort failed; proceeding with local disconnect',
        );
      }
    });
  }

  private makeClient(config: GoogleOAuthConfig): InstanceType<typeof auth.OAuth2> {
    return new auth.OAuth2({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });
  }
}

/**
 * Decode the `email` claim from a Google id_token. The id_token comes
 * directly from Google's token endpoint over a verified TLS channel (it
 * is NOT user-supplied), so we decode the payload segment without
 * re-verifying the signature — the email is display-only metadata, not
 * an authorization input. Returns null on any malformed shape.
 */
function decodeIdTokenEmail(idToken: string | null | undefined): string | null {
  if (typeof idToken !== 'string') return null;
  const segments = idToken.split('.');
  if (segments.length !== 3) return null;
  const payloadSegment = segments[1];
  if (payloadSegment === undefined || payloadSegment.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const email = (parsed as Record<string, unknown>).email;
    return typeof email === 'string' && email.length > 0 ? email : null;
  } catch {
    return null;
  }
}

/**
 * Map a thrown Google SDK error to our `auth_rejected` vs `transient`
 * axis. A 400 `invalid_grant` (refresh token revoked / expired) or a 401
 * is the "provider's grant is no longer valid → reconsent" case; every
 * other failure is transient (retry-eligible).
 */
function classifyGoogleError(err: unknown): 'auth_rejected' | 'transient' {
  const status = extractHttpStatus(err);
  if (status === 401) return 'auth_rejected';
  const message = err instanceof Error ? err.message : String(err);
  if (status === 400 && /invalid_grant/i.test(message)) return 'auth_rejected';
  return 'transient';
}

function extractHttpStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof candidate.code === 'number') return candidate.code;
  if (typeof candidate.status === 'number') return candidate.status;
  if (
    typeof candidate.response === 'object' &&
    candidate.response !== null &&
    typeof candidate.response.status === 'number'
  ) {
    return candidate.response.status;
  }
  return null;
}
