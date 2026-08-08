import type { RecordAssetEventRequest } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  type FetchFn,
  HttpScanEventClient,
  LoggingScanEventClient,
} from './http-scan-event-client';

const EVENT: RecordAssetEventRequest = {
  assetId: 'm_abc',
  eventKind: 'scan_passed',
  occurredAt: '2026-05-29T12:00:00.000Z',
};

function makeClient(fetchFn: FetchFn): HttpScanEventClient {
  return new HttpScanEventClient({
    baseUrl: 'http://service-media:3020/',
    apiKey: 'super-secret-shared-key-value',
    apiKeyHeader: 'x-internal-api-key',
    timeoutMs: 1_000,
    fetchFn,
  });
}

describe('HttpScanEventClient', () => {
  it('POSTs to the ingest endpoint with the secret header + JSON body', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchFn>[1] }> = [];
    const fetchFn: FetchFn = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
    };

    await makeClient(fetchFn).record(EVENT);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // Trailing slash on the base URL is trimmed before the path is appended.
    expect(call.url).toBe('http://service-media:3020/api/v1/internal/media/scan-events');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers['x-internal-api-key']).toBe('super-secret-shared-key-value');
    expect(call.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.init.body)).toEqual(EVENT);
  });

  it('throws on a non-2xx response — and the error never leaks the secret', async () => {
    const fetchFn: FetchFn = () =>
      Promise.resolve({ ok: false, status: 422, text: () => Promise.resolve('bad event') });

    await expect(makeClient(fetchFn).record(EVENT)).rejects.toThrow(/422/);
    await expect(makeClient(fetchFn).record(EVENT)).rejects.not.toThrow(
      /super-secret-shared-key-value/,
    );
  });

  it('propagates a transport error', async () => {
    const fetchFn: FetchFn = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(makeClient(fetchFn).record(EVENT)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('clears the timeout timer after a successful call', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const fetchFn: FetchFn = () =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') });
    await makeClient(fetchFn).record(EVENT);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe('LoggingScanEventClient', () => {
  it('resolves without throwing (stub/dev fallback)', async () => {
    await expect(new LoggingScanEventClient().record(EVENT)).resolves.toBeUndefined();
  });
});
