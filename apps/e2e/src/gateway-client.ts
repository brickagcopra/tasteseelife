import { GATEWAY_BASE_URL } from './fleet';

/**
 * Thin HTTP client for the api-gateway (TS-505).
 *
 * **Why not Playwright's `request` fixture.** `APIRequestContext` keeps a
 * cookie jar and resends automatically. Half of what this suite asserts is
 * about cookies specifically — that refresh rotates the cookie, that
 * presenting a *superseded* refresh cookie revokes the whole session family
 * (CLAUDE.md §3.1 reuse detection). Those assertions are only worth something
 * if every cookie on the wire is one the spec deliberately put there. An
 * implicit jar would make a passing reuse-detection test unfalsifiable.
 *
 * Playwright remains the runner, reporter and lifecycle owner; this is just
 * the transport.
 */

export interface GatewayRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  /** Bearer access token. */
  readonly accessToken?: string;
  /** Cookies to send, as `name=value` pairs. Nothing is sent implicitly. */
  readonly cookies?: Readonly<Record<string, string>>;
  /** `Idempotency-Key` header (CLAUDE.md §3.3 — every write endpoint honours it). */
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GatewayResponse {
  readonly status: number;
  /** Parsed JSON body, or `undefined` for an empty response. */
  readonly body: unknown;
  /** Raw body text, kept for failure messages when JSON parsing is not the point. */
  readonly text: string;
  readonly headers: Headers;
}

export async function gateway(
  path: string,
  options: GatewayRequestOptions = {},
): Promise<GatewayResponse> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.accessToken !== undefined) {
    headers['authorization'] = `Bearer ${options.accessToken}`;
  }
  if (options.idempotencyKey !== undefined) {
    headers['idempotency-key'] = options.idempotencyKey;
  }
  if (options.cookies !== undefined) {
    const pairs = Object.entries(options.cookies).map(([name, value]) => `${name}=${value}`);
    if (pairs.length > 0) {
      headers['cookie'] = pairs.join('; ');
    }
  }

  const response = await fetch(`${GATEWAY_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    // Never follow a redirect implicitly: a 3xx where a 200 was expected is a
    // finding, not something to chase to a different resource.
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let body: unknown;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }

  return { status: response.status, body, text, headers: response.headers };
}

/**
 * Read one cookie's value out of a response's `Set-Cookie` headers.
 *
 * Returns `undefined` when the header is absent, and `null` when the cookie is
 * being *cleared* (an empty value — which is how logout and reuse detection
 * present themselves). The three-way result matters: "not touched", "cleared"
 * and "rotated" are three different outcomes and a spec should be able to tell
 * them apart.
 */
export function readSetCookie(response: GatewayResponse, name: string): string | null | undefined {
  const all = response.headers.getSetCookie();
  const match = all.find((raw) => raw.startsWith(`${name}=`));
  if (match === undefined) {
    return undefined;
  }
  const value = match.slice(name.length + 1).split(';')[0] ?? '';
  return value === '' ? null : decodeURIComponent(value);
}

/** All attributes of a `Set-Cookie` header, lower-cased, for flag assertions. */
export function readSetCookieAttributes(response: GatewayResponse, name: string): string[] {
  const all = response.headers.getSetCookie();
  const match = all.find((raw) => raw.startsWith(`${name}=`));
  if (match === undefined) {
    return [];
  }
  return match
    .split(';')
    .slice(1)
    .map((part) => part.trim().toLowerCase());
}

/** The refresh-token cookie service-identity mints; forwarded verbatim by the gateway. */
export const REFRESH_COOKIE_NAME = 'tns_refresh';
