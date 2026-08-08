import { loadEnv } from './env';
import { readAccessToken, readSelectedHouseholdId } from './session';

/**
 * Server-side HTTP client for talking to api-gateway (TS-121).
 *
 * The browser NEVER makes direct calls to the gateway — every request
 * originates from a Next.js server action or a server component, which
 * (a) reads the access token from the portal's own HttpOnly cookie,
 * (b) forwards it as `Authorization: Bearer ...` to the gateway, and
 * (c) returns a typed response shape to its caller.
 *
 * Result discriminated union mirrors the gateway's own DownstreamResult
 * shape so failure handling at the Next.js layer matches the gateway's
 * RFC 7807 problem-details surface. Distinguishing `unauthorized` from
 * `client_error` lets the portal's middleware redirect to `/login` on
 * 401 without callers special-casing that status themselves.
 */

export type ApiResult<T> =
  | {
      readonly kind: 'ok';
      readonly status: number;
      readonly body: T;
      readonly setCookies: readonly string[];
    }
  | { readonly kind: 'unauthorized'; readonly status: 401 }
  | { readonly kind: 'client_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'server_error'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'network_error'; readonly detail: string };

export interface CallOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /**
   * When true the call attaches the portal's access-token cookie as
   * `Authorization: Bearer ...`. Default: true. Set false for the
   * pre-auth signup / login endpoints.
   */
  readonly authenticated?: boolean;
  /**
   * Forward an opaque cookie value to the gateway as a `Cookie` header.
   * Used by the refresh call which presents the portal's stored
   * refresh-token cookie back to the gateway under the upstream
   * cookie name service-identity expects.
   */
  readonly cookieHeader?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export async function callGateway<T>(
  path: string,
  options: CallOptions = {},
): Promise<ApiResult<T>> {
  const env = loadEnv();
  const url = `${env.API_GATEWAY_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  const method = options.method ?? 'GET';

  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(options.headers ?? {}),
  };

  if (options.authenticated !== false) {
    const token = await readAccessToken();
    if (token !== null) {
      headers['authorization'] = `Bearer ${token}`;
    }
    // TS-505d2-followup-5a1 — the household this session chose, when it had
    // to choose. Attached HERE rather than at each call site for the same
    // reason the gateway resolves the scope in one global interceptor: nine
    // family-facing surfaces need it, and an opt-in per call is how one of
    // them gets missed. Absent for the single-membership case, which the
    // gateway auto-resolves, and for anyone who belongs to no household.
    //
    // Safe to send unconditionally when set: the gateway validates it
    // against this caller's own active memberships and answers 403 on a
    // value they do not hold, so a stale cookie cannot reach another
    // family's data.
    const householdId = await readSelectedHouseholdId();
    if (householdId !== null && headers['x-household-id'] === undefined) {
      headers['x-household-id'] = householdId;
    }
  }
  if (typeof options.cookieHeader === 'string' && options.cookieHeader.length > 0) {
    headers['cookie'] = options.cookieHeader;
  }
  if (options.body !== undefined && method !== 'GET') {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      cache: 'no-store',
      ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'unknown network error';
    return { kind: 'network_error', detail };
  }

  const body = await readBody(response);
  const setCookies = readSetCookies(response);

  if (response.status === 401) {
    return { kind: 'unauthorized', status: 401 };
  }
  if (response.ok) {
    return { kind: 'ok', status: response.status, body: body as T, setCookies };
  }
  if (response.status >= 400 && response.status < 500) {
    return { kind: 'client_error', status: response.status, body };
  }
  return { kind: 'server_error', status: response.status, body };
}

async function readBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (
    contentType.includes('application/json') ||
    contentType.includes('application/problem+json')
  ) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    return await response.text();
  } catch {
    return null;
  }
}

function readSetCookies(response: Response): readonly string[] {
  const headers: unknown = response.headers;
  if (headers !== null && typeof headers === 'object' && 'getSetCookie' in headers) {
    const fn = (headers as { getSetCookie?: () => string[] }).getSetCookie;
    if (typeof fn === 'function') {
      const result = fn.call(headers);
      if (Array.isArray(result)) return result;
    }
  }
  const joined = response.headers.get('set-cookie');
  return joined === null ? [] : [joined];
}
