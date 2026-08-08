import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Env, loadEnv } from '../../../config/env';
import { SEARCH_PROVIDER_SLOT_CODE, SponsoredListingsClient } from './sponsored-listings.client';

const REQUIRED: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://test:test@localhost:5432/search_test',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
  SEARCH_INDEX_API_KEY: 'y'.repeat(32),
};

const ADS_KEY = 'z'.repeat(32);

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    ...REQUIRED,
    ADS_SERVICE_BASE_URL: 'http://service-ads:3024',
    ADS_INTERNAL_API_KEY: ADS_KEY,
    ...overrides,
  });
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async (): Promise<unknown> => {
      await Promise.resolve();
      return body;
    },
  } as unknown as Response;
}

function resolveBody(
  listings: ReadonlyArray<{ providerId: string; campaignId: string; creativeId: string }>,
): unknown {
  return {
    slotCode: SEARCH_PROVIDER_SLOT_CODE,
    listings,
    resolvedAt: '2026-06-13T12:00:00.000Z',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SponsoredListingsClient.resolve (TS-218b)', () => {
  it('returns [] without calling fetch when the feature is disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(loadEnv(REQUIRED));

    const result = await client.resolve({
      audience: { behaviorCohorts: [] },
      candidateProviderIds: ['prov_a'],
    });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] without calling fetch when there are no candidates', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(enabledEnv());

    const result = await client.resolve({
      audience: { behaviorCohorts: [] },
      candidateProviderIds: [],
    });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the slot/audience/candidates and returns the resolved listings', async () => {
    const listings = [{ providerId: 'prov_b', campaignId: 'camp_1', creativeId: 'crv_1' }];
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return okResponse(resolveBody(listings));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(enabledEnv());

    const result = await client.resolve({
      audience: { behaviorCohorts: [] },
      candidateProviderIds: ['prov_a', 'prov_b'],
    });

    expect(result).toEqual(listings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://service-ads:3024/api/v1/internal/ads/sponsored-listings/resolve');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    // Default header name; carries the shared secret.
    expect(headers['x-internal-api-key']).toBe(ADS_KEY);
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as {
      slotCode: string;
      candidateProviderIds: string[];
      limit: number;
    };
    expect(body.slotCode).toBe(SEARCH_PROVIDER_SLOT_CODE);
    expect(body.candidateProviderIds).toEqual(['prov_a', 'prov_b']);
    expect(body.limit).toBe(2); // DEFAULT_SPONSORED_SLOTS
  });

  it('honours a configured SEARCH_SPONSORED_SLOTS as the resolve limit', async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return okResponse(resolveBody([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(enabledEnv({ SEARCH_SPONSORED_SLOTS: '4' }));

    await client.resolve({ audience: { behaviorCohorts: [] }, candidateProviderIds: ['prov_a'] });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { limit: number };
    expect(body.limit).toBe(4);
  });

  it('honours a custom ADS_INTERNAL_HEADER_NAME', async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return okResponse(resolveBody([]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(
      enabledEnv({ ADS_INTERNAL_HEADER_NAME: 'x-tns-ads' }),
    );

    await client.resolve({ audience: { behaviorCohorts: [] }, candidateProviderIds: ['prov_a'] });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-tns-ads']).toBe(ADS_KEY);
    expect(headers['x-internal-api-key']).toBeUndefined();
  });

  it('returns [] on a non-2xx response (fail-open)', async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(enabledEnv());

    const result = await client.resolve({
      audience: { behaviorCohorts: [] },
      candidateProviderIds: ['prov_a'],
    });

    expect(result).toEqual([]);
  });

  it('returns [] on a non-JSON body (fail-open)', async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return {
        ok: true,
        status: 200,
        json: async (): Promise<unknown> => {
          await Promise.resolve();
          throw new Error('not json');
        },
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(enabledEnv());

    const result = await client.resolve({
      audience: { behaviorCohorts: [] },
      candidateProviderIds: ['prov_a'],
    });

    expect(result).toEqual([]);
  });

  it('returns [] on a schema-malformed body (fail-open)', async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      return okResponse({ unexpected: 'shape' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(enabledEnv());

    const result = await client.resolve({
      audience: { behaviorCohorts: [] },
      candidateProviderIds: ['prov_a'],
    });

    expect(result).toEqual([]);
  });

  it('returns [] when the fetch itself throws (network / timeout, fail-open)', async () => {
    const fetchMock = vi.fn(async () => {
      await Promise.resolve();
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new SponsoredListingsClient(enabledEnv());

    const result = await client.resolve({
      audience: { behaviorCohorts: [] },
      candidateProviderIds: ['prov_a'],
    });

    expect(result).toEqual([]);
  });
});
