import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';

import { CheckrClient } from './checkr.client';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    CHECKR_API_KEY: 'checkr-test-api-key-aaaa',
    CHECKR_API_BASE_URL: 'https://api.checkr.com/v1',
    CHECKR_DEFAULT_PACKAGE: 'tasker_standard',
    CHECKR_DEFAULT_WORK_LOCATION_STATES: 'NY',
    CHECKR_REQUEST_TIMEOUT_MS: 5_000,
    ...overrides,
  } as unknown as Env;
}

function makeFetchResponse(args: { readonly status: number; readonly body: unknown }): Response {
  const body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  return {
    ok: args.status >= 200 && args.status < 300,
    status: args.status,
    text: async () => body,
  } as unknown as Response;
}

describe('CheckrClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createCandidate', () => {
    it('returns ok with the candidate id when Checkr accepts the request', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 201, body: { id: 'cand_abc' } }));

      const client = new CheckrClient(makeEnv());
      const result = await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        ssnLast4: '1234',
        zipcode: '10021',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('cand_abc');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.checkr.com/v1/candidates');
      expect(init.method).toBe('POST');
    });

    it('uses HTTP Basic auth with the API key in the username slot', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 201, body: { id: 'cand_abc' } }));

      const client = new CheckrClient(makeEnv({ CHECKR_API_KEY: 'checkr-test-api-key-zzzz' }));
      await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const expectedAuth = `Basic ${Buffer.from('checkr-test-api-key-zzzz:').toString('base64')}`;
      expect(headers['authorization']).toBe(expectedAuth);
    });

    it('forwards the Idempotency-Key header when supplied', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 201, body: { id: 'cand_abc' } }));

      const client = new CheckrClient(makeEnv());
      await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
        idempotencyKey: 'idem-abc-1234',
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe('idem-abc-1234');
    });

    it('returns invalid_request when firstName is empty (no fetch issued)', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const client = new CheckrClient(makeEnv());
      const result = await client.createCandidate({
        firstName: '',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe('invalid_request');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects an ssnLast4 that is not exactly 4 digits', async () => {
      const client = new CheckrClient(makeEnv());
      const result = await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
        ssnLast4: '123',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe('invalid_request');
      }
    });

    it('returns checkr_unavailable on a network failure', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockRejectedValue(new Error('ECONNRESET'));

      const client = new CheckrClient(makeEnv());
      const result = await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe('checkr_unavailable');
      }
    });

    it('returns unexpected_response on non-2xx', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 422, body: { error: 'bad input' } }));

      const client = new CheckrClient(makeEnv());
      const result = await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe('unexpected_response');
        if (result.error.reason === 'unexpected_response') {
          expect(result.error.status).toBe(422);
        }
      }
    });

    it('returns unexpected_response when the body parses but has no id', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 201, body: { unrelated: 1 } }));

      const client = new CheckrClient(makeEnv());
      const result = await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe('unexpected_response');
      }
    });

    it('returns unexpected_response on non-JSON body', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 201, body: 'not json' }));

      const client = new CheckrClient(makeEnv());
      const result = await client.createCandidate({
        firstName: 'Sam',
        lastName: 'Cook',
        email: 'sam@example.com',
        phone: '+15551234567',
        dob: '1980-05-12',
        zipcode: '10021',
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('createReport', () => {
    it('returns ok with the report id + status', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(
        makeFetchResponse({ status: 201, body: { id: 'rep_abc', status: 'pending' } }),
      );

      const client = new CheckrClient(makeEnv());
      const result = await client.createReport({
        candidateId: 'cand_abc',
        packageSlug: 'tasker_standard',
        workLocationStates: ['NY'],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('rep_abc');
        expect(result.value.status).toBe('pending');
      }
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.checkr.com/v1/reports');
      const body = JSON.parse(init.body as string) as {
        candidate_id: string;
        package: string;
        work_locations: Array<{ country: string; state: string }>;
      };
      expect(body.candidate_id).toBe('cand_abc');
      expect(body.package).toBe('tasker_standard');
      expect(body.work_locations).toEqual([{ country: 'US', state: 'NY' }]);
    });

    it('returns invalid_request when candidateId is empty', async () => {
      const client = new CheckrClient(makeEnv());
      const result = await client.createReport({
        candidateId: '',
        packageSlug: 'tasker_standard',
        workLocationStates: ['NY'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe('invalid_request');
      }
    });

    it('returns invalid_request when workLocationStates is empty', async () => {
      const client = new CheckrClient(makeEnv());
      const result = await client.createReport({
        candidateId: 'cand_abc',
        packageSlug: 'tasker_standard',
        workLocationStates: [],
      });
      expect(result.ok).toBe(false);
    });

    it('returns unexpected_response when report.id is missing', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 201, body: { status: 'pending' } }));

      const client = new CheckrClient(makeEnv());
      const result = await client.createReport({
        candidateId: 'cand_abc',
        packageSlug: 'tasker_standard',
        workLocationStates: ['NY'],
      });
      expect(result.ok).toBe(false);
    });

    it('returns unexpected_response when report.status is missing', async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      fetchMock.mockResolvedValue(makeFetchResponse({ status: 201, body: { id: 'rep_abc' } }));

      const client = new CheckrClient(makeEnv());
      const result = await client.createReport({
        candidateId: 'cand_abc',
        packageSlug: 'tasker_standard',
        workLocationStates: ['NY'],
      });
      expect(result.ok).toBe(false);
    });
  });
});
