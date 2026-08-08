import { Inject, Injectable, Logger } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { AuthContextSignerService } from '../../auth-context/services/auth-context-signer.service';
import { DownstreamMetrics } from './downstream-metrics';
import { ServiceRegistry, type DownstreamServiceName } from './service-registry';

/**
 * Result of `DownstreamHttpClient.call`. Discriminated union — every
 * downstream interaction terminates in exactly one of these states.
 *
 *   - `ok` — 2xx response, body parsed.
 *   - `client_error` — 4xx response, body parsed (often an RFC 7807
 *     problem details body from the downstream service). The gateway
 *     propagates the status + body to the upstream caller verbatim.
 *   - `server_error` — 5xx response, body parsed when JSON-decodable.
 *     The gateway translates these into 502 Bad Gateway for the caller.
 *   - `timeout` — AbortController fired before the response landed.
 *     The gateway translates to 504 Gateway Timeout.
 *   - `network_error` — the fetch itself threw (DNS, connection refused,
 *     etc.). The gateway translates to 502 Bad Gateway with a generic
 *     detail string (no leak of the underlying error to the client).
 *   - `not_configured` — the registry has no base URL for the service.
 *     The gateway translates to 503 Service Unavailable with a specific
 *     detail line so ops can fix the env gap quickly.
 */
export type DownstreamResult<TBody = unknown> =
  | {
      readonly kind: 'ok';
      readonly status: number;
      readonly body: TBody;
      /**
       * Raw `Set-Cookie` header values from the downstream response.
       * Populated for every response-shaped variant so proxy controllers
       * that front cookie-bearing endpoints (auth / refresh / logout) can
       * forward them back to the upstream caller without modification.
       */
      readonly setCookies: readonly string[];
    }
  | {
      readonly kind: 'client_error';
      readonly status: number;
      readonly body: unknown;
      readonly setCookies: readonly string[];
    }
  | {
      readonly kind: 'server_error';
      readonly status: number;
      readonly body: unknown;
      readonly setCookies: readonly string[];
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network_error'; readonly detail: string }
  | { readonly kind: 'not_configured'; readonly service: DownstreamServiceName };

/**
 * The HTTP methods that mutate downstream state. Broken out because the
 * `Idempotency-Key` requirement below is keyed on exactly this set.
 */
export type DownstreamWriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface DownstreamCallOptionsBase {
  readonly service: DownstreamServiceName;
  readonly path: string;
  /** JSON-serialisable body for write methods. */
  readonly body?: unknown;
  /**
   * The verified gateway request context to sign + propagate. Optional
   * for pre-auth surfaces (signup / login / refresh) where the gateway
   * has no actor yet — the downstream service trusts those endpoints by
   * virtue of their public, rate-limited shape.
   */
  readonly actor?: RequestContext | undefined;
  /** Caller-supplied trace id (request id) propagated as `x-trace-id`. */
  readonly traceId?: string | undefined;
  /**
   * Verbatim `Cookie` header to forward to the downstream service. Used
   * by the auth proxy to relay the refresh-token cookie on
   * `POST /api/v1/auth/refresh` and `/logout` — service-identity reads
   * the refresh token from a cookie, so the gateway forwards the value
   * unparsed. Optional; omitted for endpoints that don't require it.
   */
  readonly cookieHeader?: string | undefined;
  /**
   * Override the env-wide timeout for this call. Bounded by the env
   * `DOWNSTREAM_REQUEST_TIMEOUT_MS` value (a stricter caller wins; a
   * looser caller is clamped down). Optional.
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Additional headers to attach to the downstream request — used
   * today by the TS-208 prep-checklist aggregator to forward the
   * shared-secret header that pins service-household's internal
   * `/api/v1/internal/seniors/:seniorId/prep-snapshot` endpoint.
   *
   * Header names are lowercased before merging so they don't collide
   * with the gateway's own headers (`accept`, `cookie`, etc.). The
   * gateway's own headers always win — a caller can't override the
   * actor-context trust headers or the trace-id by accident.
   *
   * Optional; omitted by default so the actor-context auth pattern
   * remains the dominant trust shape for the gateway.
   */
  readonly extraHeaders?: Readonly<Record<string, string>> | undefined;
}

/**
 * Options for one downstream call.
 *
 * **`idempotencyKey` is REQUIRED on every write method** (TS-505d-prep-followup-1).
 * It may be `undefined` — plenty of calls legitimately have no key to forward —
 * but the property must be *written*, so adding a write proxy without deciding
 * what happens to the caller's `Idempotency-Key` is a compile error rather than
 * a silent omission.
 *
 * That shape is the whole point. The option existed and was documented from the
 * start, and it was still missed at **22 of 106 write call sites** — including
 * both halves of the Stripe checkout path and the concierge-request write whose
 * downstream wears `@Idempotent()` and therefore had a replay cache with nothing
 * to key on. CLAUDE.md §3.3 says every write endpoint accepts and respects the
 * header; §17.5 makes skipping idempotency an absolute prohibition. Neither can
 * hold if the value dies at the edge, and an *optional* field is how it kept
 * dying: the two proxies that forwarded it did so because someone remembered.
 *
 * Where a call genuinely has no key to forward — a read expressed as a POST, or
 * a hop the gateway synthesises that no client issued — pass `undefined` with a
 * `// idempotency:` comment giving the reason. The reason belongs at the call
 * site, not in a central exemption list that the next omission can hide in.
 *
 * The gateway never parses, generates or transforms the value; it forwards it
 * verbatim and the downstream's own validation bounds it.
 */
export type DownstreamCallOptions =
  | (DownstreamCallOptionsBase & {
      readonly method?: 'GET' | undefined;
      readonly idempotencyKey?: string | undefined;
    })
  | (DownstreamCallOptionsBase & {
      readonly method: DownstreamWriteMethod;
      readonly idempotencyKey: string | undefined;
    });

/**
 * Thin wrapper around Node 22 `fetch` that:
 *
 *   1. Resolves `service` → base URL via `ServiceRegistry`.
 *   2. Mints the gateway → downstream trust headers via
 *      `AuthContextSignerService`.
 *   3. Applies an `AbortController`-backed timeout (per-call override
 *      clamped to the env ceiling).
 *   4. Maps the response into a typed `DownstreamResult` discriminated
 *      union the proxy controller can render into the HTTP response.
 *
 * No retry logic in Phase 1 — every retry choice (which methods to
 * retry, with how much backoff) is endpoint-specific. The proxy
 * controller can wrap the call with its own retry policy when the
 * idempotency story warrants it. Adding default retries here would
 * make the failure mode harder to debug and the contract less explicit.
 *
 * Body decoding: response body is read as JSON when the content-type
 * is JSON-shaped, otherwise as text. Non-decodable bodies surface as
 * the raw string in the `body` field so the upstream can decide
 * whether to pass through or wrap.
 */
@Injectable()
export class DownstreamHttpClient {
  private readonly logger = new Logger(DownstreamHttpClient.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly registry: ServiceRegistry,
    private readonly signer: AuthContextSignerService,
    private readonly metrics: DownstreamMetrics,
  ) {}

  /**
   * Make one downstream call and classify it.
   *
   * TS-140-followup-4 wraps `execute` rather than sprinkling `record(...)`
   * across its six return points: every terminal state is recorded because
   * the recording happens where the union is consumed, so a seventh variant
   * added later cannot be silently missed.
   */
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    const startNs = process.hrtime.bigint();
    const result = await this.execute<TBody>(options);
    this.metrics.recordCall(
      options.service,
      result.kind,
      Number(process.hrtime.bigint() - startNs) / 1e9,
    );
    return result;
  }

  private async execute<TBody = unknown>(
    options: DownstreamCallOptions,
  ): Promise<DownstreamResult<TBody>> {
    const baseUrl = this.registry.baseUrl(options.service);
    if (baseUrl === null) {
      return { kind: 'not_configured', service: options.service };
    }

    const url = `${baseUrl}${options.path.startsWith('/') ? options.path : `/${options.path}`}`;
    const method = options.method ?? 'GET';

    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (options.extraHeaders !== undefined) {
      // Caller-supplied headers go in first so the gateway's own
      // headers (set immediately below) overwrite them on any
      // collision. Lowercased on entry — HTTP headers are case-
      // insensitive, but Node 22 `fetch` exposes them verbatim and a
      // mixed-case key would create a duplicate header rather than
      // overwriting.
      for (const [k, v] of Object.entries(options.extraHeaders)) {
        headers[k.toLowerCase()] = v;
      }
    }
    if (options.actor !== undefined) {
      // Mint trust headers only for authenticated proxies. Pre-auth
      // routes (signup, login, refresh) call downstream without an
      // actor identity — the rate-limit guard + the route's public
      // contract are the trust posture.
      const trustHeaders = this.signer.sign(options.actor);
      for (const [k, v] of Object.entries(trustHeaders)) headers[k] = v;
    }
    if (typeof options.traceId === 'string' && options.traceId.length > 0) {
      headers['x-trace-id'] = options.traceId;
    }
    if (typeof options.cookieHeader === 'string' && options.cookieHeader.length > 0) {
      headers['cookie'] = options.cookieHeader;
    }
    if (typeof options.idempotencyKey === 'string' && options.idempotencyKey.length > 0) {
      headers['idempotency-key'] = options.idempotencyKey;
    }
    if (options.body !== undefined && method !== 'GET') {
      headers['content-type'] = 'application/json';
    }

    const timeout = clampTimeout(options.timeoutMs, this.env.DOWNSTREAM_REQUEST_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
      });
    } catch (cause) {
      const aborted = controller.signal.aborted;
      if (aborted) {
        this.logger.warn(
          { service: options.service, path: options.path, timeoutMs: timeout },
          'downstream call timed out',
        );
        return { kind: 'timeout' };
      }
      const detail = cause instanceof Error ? cause.message : 'unknown network error';
      this.logger.warn(
        { service: options.service, path: options.path, detail },
        'downstream call failed at the network layer',
      );
      return { kind: 'network_error', detail };
    } finally {
      clearTimeout(timer);
    }

    const body = await readBody(response);
    const setCookies = readSetCookies(response);

    if (response.ok) {
      return { kind: 'ok', status: response.status, body: body as TBody, setCookies };
    }
    if (response.status >= 400 && response.status < 500) {
      return { kind: 'client_error', status: response.status, body, setCookies };
    }
    return { kind: 'server_error', status: response.status, body, setCookies };
  }
}

/**
 * Extract `Set-Cookie` header values from a fetch `Response`. Node 22's
 * `Headers.getSetCookie()` returns one entry per cookie (vs. the legacy
 * comma-joined single string from `Headers.get`), preserving cookie
 * boundaries even when attribute values themselves contain commas (e.g.
 * `Expires=Wed, 21 Oct 2026 ...`). Falls back to `Headers.get` for the
 * pathological case where `getSetCookie` is missing (older Node, test
 * doubles) — splitting on the same loosely-defined boundary the legacy
 * surface uses.
 */
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
  if (joined === null) return [];
  return [joined];
}

function clampTimeout(callerMs: number | undefined, envMs: number): number {
  if (callerMs === undefined) return envMs;
  // Caller can request a STRICTER timeout (smaller value), but not a
  // looser one — env is the ceiling so a single misbehaving endpoint
  // can't take down the gateway by holding a connection for minutes.
  return Math.min(callerMs, envMs);
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
