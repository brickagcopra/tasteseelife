import { afterEach, describe, expect, it, vi } from 'vitest';

import { PagerDutyClient } from './client';
import { type ValidatedPagerDutyOptions, validatePagerDutyOptions } from './module/options';

/**
 * Unit tests for `PagerDutyClient` — ported verbatim from the
 * service-concierge TS-225 suite by TS-302b, with the `Env` fixture swapped
 * for the module-options fixture. Every assertion is unchanged, which is the
 * point: the extraction is a move, not a rewrite.
 *
 * The Events API v2 call is a native `fetch` POST; tests stub
 * `globalThis.fetch` to drive each branch (sent / unconfigured / non-2xx /
 * network error / timeout) and to capture the request body so the payload
 * shape stays pinned.
 */

function buildOptions(
  overrides: Partial<ValidatedPagerDutyOptions> = {},
): ValidatedPagerDutyOptions {
  return validatePagerDutyOptions({
    routingKey: 'routing-key-123',
    eventsUrl: 'https://events.pagerduty.com/v2/enqueue',
    source: 'service-concierge',
    timeoutMs: 5_000,
    ...overrides,
  });
}

const INPUT = {
  dedupKey: 'concierge-emergency-tk_1',
  summary: '[Taste & See] Emergency concierge (medical) — ticket tk_1',
  severity: 'critical' as const,
  customDetails: { ticketId: 'tk_1', householdId: 'hh_1', category: 'medical' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PagerDutyClient.enqueue', () => {
  it('skips paging when the routing key is unconfigured (without calling fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new PagerDutyClient(buildOptions({ routingKey: undefined }));

    const result = await client.enqueue(INPUT);

    expect(result.kind).toBe('skipped_unconfigured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a trigger event and resolves sent on a 2xx response', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"status":"success"}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new PagerDutyClient(buildOptions());

    const result = await client.enqueue(INPUT);

    expect(result.kind).toBe('sent');
    if (result.kind === 'sent') expect(result.dedupKey).toBe('concierge-emergency-tk_1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends the Events API v2 payload shape', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('{}', { status: 202 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new PagerDutyClient(buildOptions());

    await client.enqueue(INPUT);

    expect(capturedUrl).toBe('https://events.pagerduty.com/v2/enqueue');
    expect(capturedBody?.['routing_key']).toBe('routing-key-123');
    expect(capturedBody?.['event_action']).toBe('trigger');
    expect(capturedBody?.['dedup_key']).toBe('concierge-emergency-tk_1');
    const payload = capturedBody?.['payload'] as Record<string, unknown>;
    expect(payload['summary']).toContain('Emergency concierge');
    expect(payload['source']).toBe('service-concierge');
    expect(payload['severity']).toBe('critical');
    expect(payload['custom_details']).toMatchObject({ ticketId: 'tk_1' });
  });

  it('resolves failed on a non-2xx response (carrying the status)', async () => {
    const fetchSpy = vi.fn(async () => new Response('bad routing key', { status: 400 }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = new PagerDutyClient(buildOptions());

    const result = await client.enqueue(INPUT);

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.detail).toContain('400');
  });

  it('resolves failed on a network error (never throws)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new PagerDutyClient(buildOptions());

    const result = await client.enqueue(INPUT);

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.detail).toContain('ECONNREFUSED');
  });

  it('maps an AbortError to a timeout failure detail', async () => {
    const fetchSpy = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new PagerDutyClient(buildOptions({ timeoutMs: 1_000 }));

    const result = await client.enqueue(INPUT);

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.detail).toContain('timed out');
  });
});

describe('PagerDutyClient — per-host configuration (TS-302b)', () => {
  it('stamps the configured source, so a second host does not page as concierge', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response('{}', { status: 202 });
      }),
    );
    const client = new PagerDutyClient(buildOptions({ source: 'service-trust-safety' }));

    await client.enqueue(INPUT);

    const payload = capturedBody?.['payload'] as Record<string, unknown>;
    expect(payload['source']).toBe('service-trust-safety');
  });

  it('posts to the configured region endpoint', async () => {
    let capturedUrl: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return new Response('{}', { status: 202 });
      }),
    );
    const client = new PagerDutyClient(
      buildOptions({ eventsUrl: 'https://events.eu.pagerduty.com/v2/enqueue' }),
    );

    await client.enqueue(INPUT);

    expect(capturedUrl).toBe('https://events.eu.pagerduty.com/v2/enqueue');
  });

  it('clears the abort timer on the success path (no dangling handle)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 202 })),
    );
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const client = new PagerDutyClient(buildOptions());

    await client.enqueue(INPUT);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
