import { type CallHandler, type ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpMetricsInterceptor } from './http-metrics.interceptor';

/**
 * Behavioural contracts for `HttpMetricsInterceptor`:
 *
 *   - Successful request → `http_server_requests_total` increments + the
 *     duration histogram records a sample, labelled with method / route /
 *     status_code (200 by default).
 *   - Controller throws `HttpException` → the interceptor still records,
 *     using the exception's HTTP status.
 *   - Controller throws non-`HttpException` (a code bug, basically) →
 *     status_code is `500`.
 *   - Route template fallback: when the matched route isn't on the
 *     request, the label is the literal `unknown` (closes cardinality).
 *   - Non-HTTP contexts (RPC / WS) are passed through untouched.
 *   - The meter name is derived from the injected service name (the only
 *     parameterization the lift adds over the verbatim per-service copies).
 */
describe('HttpMetricsInterceptor', () => {
  let interceptor: HttpMetricsInterceptor;

  beforeEach(() => {
    initMetrics({
      service: 'nest-observability-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
    interceptor = new HttpMetricsInterceptor('service-test');
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records a successful 200 response', async () => {
    const ctx = buildExecutionContext({
      type: 'http',
      method: 'GET',
      route: '/healthz',
      statusCode: 200,
    });
    const handler = buildCallHandlerOf('healthy');

    const result = await firstValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toBe('healthy');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /http_server_requests_total\{[^}]*method="GET"[^}]*route="\/healthz"[^}]*status_code="200"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*method="GET"[^}]*route="\/healthz"[^}]*status_code="200"[^}]*\} 1/,
    );
  });

  it('records a thrown HttpException with the exception status', async () => {
    const ctx = buildExecutionContext({
      type: 'http',
      method: 'POST',
      route: '/api/v1/auth/login',
      statusCode: 200,
    });
    const handler = buildCallHandlerError(new HttpException('bad creds', HttpStatus.UNAUTHORIZED));

    await expect(firstValueFrom(interceptor.intercept(ctx, handler))).rejects.toThrow('bad creds');

    const out = await serializeMetrics();
    expect(out).toMatch(
      /http_server_requests_total\{[^}]*method="POST"[^}]*route="\/api\/v1\/auth\/login"[^}]*status_code="401"[^}]*\} 1/,
    );
  });

  it('records a non-HttpException error as status 500', async () => {
    const ctx = buildExecutionContext({
      type: 'http',
      method: 'GET',
      route: '/api/v1/auth/me',
      statusCode: 200,
    });
    const handler = buildCallHandlerError(new Error('boom'));

    await expect(firstValueFrom(interceptor.intercept(ctx, handler))).rejects.toThrow('boom');

    const out = await serializeMetrics();
    expect(out).toMatch(/http_server_requests_total\{[^}]*status_code="500"[^}]*\} 1/);
  });

  it('falls back to route=unknown when the matched route is missing', async () => {
    const ctx = buildExecutionContext({
      type: 'http',
      method: 'GET',
      route: undefined,
      statusCode: 404,
    });
    const handler = buildCallHandlerOf(undefined);

    await firstValueFrom(interceptor.intercept(ctx, handler));

    const out = await serializeMetrics();
    expect(out).toMatch(/http_server_requests_total\{[^}]*route="unknown"[^}]*\} 1/);
  });

  it('passes through non-HTTP contexts without recording', async () => {
    const ctx = buildExecutionContext({
      type: 'rpc',
      method: 'IGNORED',
      route: '/ignored',
      statusCode: 200,
    });
    const handler = buildCallHandlerOf('rpc-response');

    const result = await firstValueFrom(interceptor.intercept(ctx, handler));
    expect(result).toBe('rpc-response');

    const out = await serializeMetrics();
    expect(out).not.toMatch(/http_server_requests_total/);
  });

  it('aggregates two requests for the same route under one counter sample', async () => {
    const ctx = buildExecutionContext({
      type: 'http',
      method: 'GET',
      route: '/readyz',
      statusCode: 200,
    });

    await firstValueFrom(interceptor.intercept(ctx, buildCallHandlerOf('ok-1')));
    await firstValueFrom(interceptor.intercept(ctx, buildCallHandlerOf('ok-2')));

    const out = await serializeMetrics();
    expect(out).toMatch(
      /http_server_requests_total\{[^}]*route="\/readyz"[^}]*status_code="200"[^}]*\} 2/,
    );
  });

  it('composes baseUrl + route.path for nested routers', async () => {
    const ctx = buildExecutionContext({
      type: 'http',
      method: 'GET',
      route: '/items',
      baseUrl: '/api/v1/inventory',
      statusCode: 200,
    });

    await firstValueFrom(interceptor.intercept(ctx, buildCallHandlerOf('ok')));

    const out = await serializeMetrics();
    expect(out).toMatch(
      /http_server_requests_total\{[^}]*route="\/api\/v1\/inventory\/items"[^}]*\} 1/,
    );
  });

  it('derives the counter description from the injected service name', async () => {
    // Self-contained: reset the provider so the only `http_server_requests_total`
    // counter is the one this `service-other` interceptor creates (two
    // same-named counters with different HELP lines would conflict in the
    // Prometheus exposition). The beforeEach `service-test` interceptor lived
    // on the now-discarded provider.
    await shutdownMetrics();
    initMetrics({
      service: 'nest-observability-test',
      env: 'test',
      exportIntervalMillis: 3_600_000,
    });
    const other = new HttpMetricsInterceptor('service-other');
    const ctx = buildExecutionContext({
      type: 'http',
      method: 'GET',
      route: '/ping',
      statusCode: 200,
    });

    await firstValueFrom(other.intercept(ctx, buildCallHandlerOf('ok')));

    const out = await serializeMetrics();
    expect(out).toMatch(/Total HTTP requests handled by service-other/);
  });
});

interface ContextOptions {
  type: 'http' | 'rpc' | 'ws';
  method: string;
  route: string | undefined;
  statusCode: number;
  baseUrl?: string;
}

function buildExecutionContext(opts: ContextOptions): ExecutionContext {
  const request = {
    method: opts.method,
    baseUrl: opts.baseUrl ?? '',
    ...(opts.route !== undefined ? { route: { path: opts.route } } : {}),
  };
  const response = { statusCode: opts.statusCode };
  return {
    getType: () => opts.type,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
      getNext: () => undefined,
    }),
    switchToRpc: () => ({
      getContext: () => ({}),
      getData: () => ({}),
    }),
    switchToWs: () => ({
      getClient: () => ({}),
      getData: () => ({}),
      getPattern: () => '',
    }),
    getClass: () => Object,
    getHandler: () => () => undefined,
    getArgs: () => [],
    getArgByIndex: () => undefined,
  } as unknown as ExecutionContext;
}

function buildCallHandlerOf<T>(value: T): CallHandler<T> {
  return {
    handle: () => of(value),
  };
}

function buildCallHandlerError(err: unknown): CallHandler<never> {
  return {
    handle: () => throwError(() => err),
  };
}
