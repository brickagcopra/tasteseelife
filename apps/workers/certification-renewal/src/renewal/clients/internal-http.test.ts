import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { InternalHttpError, internalRequest, trimBaseUrl } from './internal-http';

const Schema = z.object({ ok: z.boolean() }).strict();
const logger = new Logger('test');

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function baseOpts() {
  return {
    service: 'service-x',
    url: 'http://svc/api',
    headerName: 'x-internal-api-key',
    apiKey: 'secret',
    timeoutMs: 1000,
    schema: Schema,
    logger,
  } as const;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('trimBaseUrl', () => {
  it('strips a single trailing slash', () => {
    expect(trimBaseUrl('http://svc/')).toBe('http://svc');
    expect(trimBaseUrl('http://svc')).toBe('http://svc');
  });
});

describe('internalRequest', () => {
  it('returns the parsed body on 2xx and sends the shared-secret header', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await internalRequest({ ...baseOpts(), method: 'GET' });
    expect(result).toEqual({ ok: true });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-internal-api-key']).toBe('secret');
    expect(init.method).toBe('GET');
  });

  it('serialises a JSON body + content-type on POST', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await internalRequest({ ...baseOpts(), method: 'POST', body: { certificationId: 'a' } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ certificationId: 'a' }));
  });

  it('throws with the HTTP status on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' }, 404)),
    );
    await expect(internalRequest({ ...baseOpts(), method: 'GET' })).rejects.toMatchObject({
      name: 'InternalHttpError',
      status: 404,
    });
  });

  it('classifies a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))),
    );
    await expect(internalRequest({ ...baseOpts(), method: 'GET' })).rejects.toMatchObject({
      status: 'network',
    });
  });

  it('classifies an aborted request as a timeout', async () => {
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(abortErr)),
    );
    await expect(internalRequest({ ...baseOpts(), method: 'GET' })).rejects.toMatchObject({
      status: 'timeout',
    });
  });

  it('throws a schema error when the body violates the contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: 'not-a-bool' })),
    );
    const err = await internalRequest({ ...baseOpts(), method: 'GET' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InternalHttpError);
    expect((err as InternalHttpError).status).toBe('schema');
  });
});
