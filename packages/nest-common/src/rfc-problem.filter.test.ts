import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { captureException } from '@taste-and-see/sentry/node';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RfcProblemFilter } from './rfc-problem.filter';

vi.mock('@taste-and-see/sentry/node', () => ({ captureException: vi.fn() }));
const captureExceptionMock = vi.mocked(captureException);

beforeEach(() => {
  captureExceptionMock.mockClear();
});

interface CapturedResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

function buildHost(args: { request: Partial<Request> }): {
  host: ArgumentsHost;
  captured: { value?: CapturedResponse };
} {
  const captured: { value?: CapturedResponse } = {};
  const json = vi.fn((body: Record<string, unknown>) => {
    return body;
  });
  const status = vi.fn((statusCode: number) => {
    captured.value = { status: statusCode, body: {} };
    return {
      json: (body: Record<string, unknown>): Record<string, unknown> => {
        if (captured.value !== undefined) {
          captured.value = { status: statusCode, body };
        }
        return json(body);
      },
    } as unknown as Response;
  });

  const response = { status } as unknown as Response;

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => args.request as Request,
      getNext: () => vi.fn(),
    }),
  } as unknown as ArgumentsHost;

  return { host, captured };
}

describe('RfcProblemFilter', () => {
  const filter = new RfcProblemFilter();

  it('preserves Problem Details fields when the controller already shaped them', () => {
    const exception = new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'Request payload failed validation.',
      errors: [{ path: 'displayName', code: 'invalid_string', message: 'required' }],
    });

    const { host, captured } = buildHost({
      request: {
        url: '/api/v1/something',
        method: 'POST',
        headers: { 'x-trace-id': 'trace-abc' },
      },
    });

    filter.catch(exception, host);

    expect(captured.value?.status).toBe(400);
    expect(captured.value?.body['title']).toBe('Bad Request');
    expect(captured.value?.body['detail']).toBe('Request payload failed validation.');
    expect(captured.value?.body['errors']).toEqual([
      { path: 'displayName', code: 'invalid_string', message: 'required' },
    ]);
    expect(captured.value?.body['traceId']).toBe('trace-abc');
    expect(captured.value?.body['instance']).toBe('/api/v1/something');
  });

  /**
   * TS-510 — `code` is the machine-readable discriminator four shipped
   * features attach for a client to branch on (the admin MFA-enrolment gate,
   * the SSO gate, and the three email-verification rejections). The filter
   * used to allow-list only `errors`, so none of them ever received it, and
   * web-admin's login action was carrying the whole feature on a
   * `/mfa|multi-factor/i` regex over the human-facing `detail`.
   */
  it('preserves the machine-readable `code` extension member', () => {
    const exception = new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'That verification link is not valid. Request a new one to continue.',
      code: 'verification_token_already_consumed',
    });

    const { host, captured } = buildHost({
      request: { url: '/api/v1/auth/verify-email', method: 'POST', headers: {} },
    });

    filter.catch(exception, host);

    expect(captured.value?.body['code']).toBe('verification_token_already_consumed');
  });

  it('preserves the `issues` array the gateway attaches to a pre-flight rejection', () => {
    const exception = new BadRequestException({
      title: 'Bad Request',
      status: 400,
      detail: 'Signup payload failed validation.',
      issues: [{ path: ['password'], message: 'too short' }],
    });

    const { host, captured } = buildHost({
      request: { url: '/api/v1/auth/signup', method: 'POST', headers: {} },
    });

    filter.catch(exception, host);

    expect(captured.value?.body['issues']).toEqual([{ path: ['password'], message: 'too short' }]);
  });

  /**
   * The allow-list is the point: an exception body is a convenient place for
   * internal detail to accumulate, so anything not named is dropped. A spread
   * here is how a stack trace or an internal id reaches a client.
   */
  it('drops extension members that are not on the allow-list', () => {
    const exception = new BadRequestException({
      title: 'Bad Request',
      status: 400,
      detail: 'nope',
      code: 'a_code',
      stack: 'at Injector.lookupComponentInParentModules (...)',
      internalUserId: 'usr_123',
      sql: 'SELECT * FROM identity.users',
    });

    const { host, captured } = buildHost({
      request: { url: '/x', method: 'POST', headers: {} },
    });

    filter.catch(exception, host);

    expect(captured.value?.body['code']).toBe('a_code');
    expect(captured.value?.body['stack']).toBeUndefined();
    expect(captured.value?.body['internalUserId']).toBeUndefined();
    expect(captured.value?.body['sql']).toBeUndefined();
  });

  /** A non-string `code` is not a discriminator; it is a mistake, and dropped. */
  it('drops a non-string `code`', () => {
    const { host, captured } = buildHost({
      request: { url: '/x', method: 'POST', headers: {} },
    });

    filter.catch(
      new BadRequestException({ title: 'Bad Request', status: 400, detail: 'x', code: 42 }),
      host,
    );

    expect(captured.value?.body['code']).toBeUndefined();
  });

  it('uses x-request-id when x-trace-id is missing', () => {
    const { host, captured } = buildHost({
      request: { url: '/x', method: 'GET', headers: { 'x-request-id': 'req-42' } },
    });

    filter.catch(new ConflictException('boom'), host);
    expect(captured.value?.body['traceId']).toBe('req-42');
  });

  it('uses traceparent when x-trace-id and x-request-id are missing', () => {
    const { host, captured } = buildHost({
      request: {
        url: '/x',
        method: 'GET',
        headers: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' },
      },
    });

    filter.catch(new ConflictException('boom'), host);
    expect(captured.value?.body['traceId']).toBe(
      '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    );
  });

  it('falls back to a generated UUID when no trace headers are present', () => {
    const { host, captured } = buildHost({
      request: { url: '/x', method: 'GET', headers: {} },
    });

    filter.catch(new HttpException('teapot', 418), host);
    expect(typeof captured.value?.body['traceId']).toBe('string');
    expect((captured.value?.body['traceId'] as string).length).toBeGreaterThan(8);
  });

  it('synthesises a Problem body when the exception payload is just a string', () => {
    const { host, captured } = buildHost({
      request: { url: '/x', method: 'GET', headers: {} },
    });
    filter.catch(new BadRequestException('something simple'), host);

    expect(captured.value?.status).toBe(400);
    expect(captured.value?.body['title']).toBe('Bad Request');
    expect(captured.value?.body['detail']).toBe('something simple');
  });

  it('returns 500 with a generic detail for unexpected errors (no leakage)', () => {
    const { host, captured } = buildHost({
      request: { url: '/x', method: 'GET', headers: {} },
    });
    const err = new Error('internal driver failure: secret_db_pwd=hunter2');
    filter.catch(err, host);

    expect(captured.value?.status).toBe(500);
    expect(captured.value?.body['detail']).toBe('An unexpected error occurred.');
    expect(JSON.stringify(captured.value?.body)).not.toContain('hunter2');
  });

  it('returns 500 for non-Error throws (string, object) without leaking the value', () => {
    const { host, captured } = buildHost({
      request: { url: '/x', method: 'GET', headers: {} },
    });
    filter.catch('a raw string with secret_token=abc', host);

    expect(captured.value?.status).toBe(500);
    expect(captured.value?.body['detail']).toBe('An unexpected error occurred.');
    expect(JSON.stringify(captured.value?.body)).not.toContain('secret_token');
  });

  it('defaults the title from the status code for uncommon statuses', () => {
    const { host, captured } = buildHost({
      request: { url: '/x', method: 'GET', headers: {} },
    });
    filter.catch(new HttpException('teapot', 418), host);
    expect(captured.value?.body['title']).toBe('Error');
  });
});

/**
 * Sentry capture (TS-504-followup-2a).
 *
 * This filter is the only place an in-request error can reach Sentry — Nest
 * catches everything before it reaches `process`, so the SDK's
 * `onUncaughtException` integration never sees a 500 a user actually hit.
 */
describe('RfcProblemFilter — Sentry capture', () => {
  function run(exception: unknown, request: Partial<Request>): void {
    const { host } = buildHost({ request });
    new RfcProblemFilter().catch(exception, host);
  }

  const baseRequest: Partial<Request> = {
    url: '/api/v1/bookings',
    method: 'POST',
    headers: {},
  };

  it('reports an unhandled non-HTTP exception', () => {
    const err = new Error('driver exploded');
    run(err, baseRequest);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]?.[0]).toBe(err);
  });

  it('reports a 5xx HttpException — including the gateway 502 on contract drift', () => {
    run(new HttpException('downstream drift', 502), baseRequest);
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]?.[1]).toMatchObject({ status: 502 });
  });

  it('does NOT report 4xx, which are business outcomes and would bury the failures', () => {
    for (const exception of [
      new BadRequestException('bad'),
      new ConflictException('conflict'),
      new HttpException('forbidden', 403),
      new HttpException('not found', 404),
      new HttpException('unprocessable', 422),
    ]) {
      run(exception, baseRequest);
    }
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('carries the traceId, so the report names the span to open in the collector', () => {
    run(new Error('boom'), {
      ...baseRequest,
      headers: { 'x-request-id': 'trace-abc' },
    });
    expect(captureExceptionMock.mock.calls[0]?.[1]).toMatchObject({ traceId: 'trace-abc' });
  });

  it('sends the route PATTERN when Express resolved one, not the concrete id', () => {
    // `/bookings/bk_live_123` is a low-cardinality grouping problem in Sentry
    // and an identifier we have no reason to hand a third party.
    run(new Error('boom'), {
      ...baseRequest,
      url: '/api/v1/bookings/bk_live_123',
      route: { path: '/api/v1/bookings/:id' } as Request['route'],
    });
    expect(captureExceptionMock.mock.calls[0]?.[1]).toMatchObject({
      path: '/api/v1/bookings/:id',
    });
  });

  it('strips the query string when falling back to the raw URL', () => {
    // The fallback path is the one that would otherwise ship `?token=...`.
    run(new Error('boom'), {
      ...baseRequest,
      url: '/api/v1/auth/reset?token=abc123&next=/home',
    });
    expect(captureExceptionMock.mock.calls[0]?.[1]).toMatchObject({
      path: '/api/v1/auth/reset',
    });
  });

  it('never puts the body, headers or query in the envelope', () => {
    run(new Error('boom'), {
      ...baseRequest,
      url: '/api/v1/auth/login?token=abc',
      headers: { authorization: 'Bearer secret' },
      body: { password: 'hunter2' },
    } as Partial<Request>);

    const context = captureExceptionMock.mock.calls[0]?.[1] as Record<string, unknown>;
    // Chosen-inclusion, not filtered-arrival: the keys present are the whole
    // contract, so a future field cannot be added without editing this list.
    expect(Object.keys(context).sort()).toEqual(['method', 'path', 'status', 'traceId']);
    expect(JSON.stringify(context)).not.toContain('hunter2');
    expect(JSON.stringify(context)).not.toContain('Bearer');
    expect(JSON.stringify(context)).not.toContain('abc');
  });

  it('still returns the uninformative 500 body to the client', () => {
    // Reporting must not change what the caller sees (§3.9).
    const { host, captured } = buildHost({ request: baseRequest });
    new RfcProblemFilter().catch(new Error('driver: dsn=postgres://u:p@h/db'), host);
    expect(captured.value?.status).toBe(500);
    expect(captured.value?.body['detail']).toBe('An unexpected error occurred.');
    expect(JSON.stringify(captured.value?.body)).not.toContain('postgres://');
  });
});
