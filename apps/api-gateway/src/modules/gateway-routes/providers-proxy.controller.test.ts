import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { ProvidersProxyController } from './providers-proxy.controller';

/**
 * Test coverage for the providers BFF proxy (TS-200-followup-4a).
 *
 * Closes the pre-existing gap surfaced during TS-200-followup-4: every
 * other gateway proxy has a sibling test file but `providers-proxy.
 * controller.ts` slipped through when TS-200 / TS-203 landed. Mirrors
 * the canonical shape of `admin-search-ranking-config-proxy.controller.
 * test.ts` / `bookings-proxy.controller.test.ts`:
 *
 *   - happy path + return shape + forwarded `DownstreamCallOptions`
 *     (service / path / method / actor / idempotencyKey)
 *   - 401 (no requestContext)
 *   - 502 on network_error / server_error / contract-violating body
 *   - 504 on timeout
 *   - 503 on not_configured
 *   - 4xx forwarded verbatim
 *
 * Twelve describe blocks — one per endpoint:
 *   1. `getMyProfileSnapshot`
 *   2. `getProfileById`             (TS-200-followup-4)
 *   3. `updateProfile`
 *   4. `getMyAvailabilitySnapshot`  (TS-203)
 *   5. `updateAvailability`         (TS-203)
 *   6. `deleteAvailability`         (TS-203)
 *   7. `getMyServiceAreasSnapshot`  (TS-202)
 *   8. `updateServiceAreas`         (TS-202)
 *   9. `deleteServiceAreas`         (TS-202)
 *   10. `getMyPricingSnapshot`      (TS-204)
 *   11. `getPricingById`            (TS-204)
 *   12. `updatePricing`             (TS-204)
 */

class StubDownstreamClient {
  public lastOptions: DownstreamCallOptions | null = null;
  constructor(private readonly result: DownstreamResult) {}
  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.lastOptions = options;
    return this.result as DownstreamResult<TBody>;
  }
}

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_provider',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

const NOW_ISO = '2026-05-21T12:00:00.000Z';

const VALID_PROFILE_RECORD = {
  id: 'prv_abc',
  status: 'active' as const,
  tier: 'certified' as const,
  displayName: 'Chef Estelle',
  headline: 'Comfort cuisine + companion dining',
  bio: 'Two decades of warm, family-style kitchens.',
  profilePhotoKey: null,
  videoIntroKey: null,
  timeZone: 'America/New_York',
  dementiaSensitive: true,
  languages: ['english', 'spanish'],
  cuisines: ['italian', 'mediterranean'],
  dietaryExpertise: ['low-sodium', 'soft-textures'],
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const VALID_PROFILE_SNAPSHOT_RESPONSE = {
  profile: VALID_PROFILE_RECORD,
};

const VALID_PROFILE_SNAPSHOT_NULL_RESPONSE = {
  profile: null,
};

const VALID_UPDATE_PROFILE_BODY = {
  bio: 'Refreshed bio — warmer companion dining focus.',
  languages: ['english', 'spanish'],
  cuisines: ['italian', 'mediterranean'],
  dietaryExpertise: ['low-sodium'],
  dementiaSensitive: true,
};

const VALID_UPDATE_PROFILE_RESPONSE = {
  profile: VALID_PROFILE_RECORD,
};

const VALID_AVAILABILITY_RECORD = {
  providerId: 'prv_abc',
  timeZone: 'America/New_York',
  windows: [
    { weekday: 'monday' as const, startTime: '09:00', endTime: '13:00' },
    { weekday: 'thursday' as const, startTime: '18:00', endTime: '21:00' },
  ],
  exceptions: [{ date: '2026-12-25' }],
  updatedAt: NOW_ISO,
};

const VALID_AVAILABILITY_SNAPSHOT_RESPONSE = {
  availability: VALID_AVAILABILITY_RECORD,
};

const VALID_AVAILABILITY_SNAPSHOT_NULL_RESPONSE = {
  availability: null,
};

const VALID_UPDATE_AVAILABILITY_BODY = {
  windows: [
    { weekday: 'monday' as const, startTime: '09:00', endTime: '13:00' },
    { weekday: 'thursday' as const, startTime: '18:00', endTime: '21:00' },
  ],
  exceptions: [{ date: '2026-12-25' }],
};

const VALID_UPDATE_AVAILABILITY_RESPONSE = {
  availability: VALID_AVAILABILITY_RECORD,
};

const VALID_DELETE_AVAILABILITY_RESPONSE = {
  providerId: 'prv_abc',
  deletedWindowCount: 2,
  deletedExceptionCount: 1,
};

// ─── Pricing (TS-204) ────────────────────────────────────────────────────

const VALID_PRICING_RECORD = {
  providerId: 'prv_abc',
  status: 'active' as const,
  tier: 'certified' as const,
  hourlyRateMinor: 7500,
  currency: 'USD',
  band: { tier: 'certified' as const, minHourlyRateMinor: 6000, maxHourlyRateMinor: 12000 },
  updatedAt: NOW_ISO,
};

const VALID_PRICING_SNAPSHOT_RESPONSE = { pricing: VALID_PRICING_RECORD };
const VALID_PRICING_SNAPSHOT_NULL_RESPONSE = { pricing: null };
const VALID_UPDATE_PRICING_BODY = { hourlyRateMinor: 7500, currency: 'USD' };
const VALID_UPDATE_PRICING_RESPONSE = { pricing: VALID_PRICING_RECORD };

function buildController(stub: StubDownstreamClient): ProvidersProxyController {
  return new ProvidersProxyController(stub as unknown as DownstreamHttpClient);
}

// ─────────────────────────────────────────────────────────────────────
// getMyProfileSnapshot()
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.getMyProfileSnapshot', () => {
  it('returns the parsed snapshot + forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PROFILE_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getMyProfileSnapshot(REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_PROFILE_SNAPSHOT_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/me/profile-snapshot');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
    expect(stub.lastOptions?.traceId).toBe('tr_test_001');
  });

  it('passes through the null-profile snapshot (no provider row yet)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PROFILE_SNAPSHOT_NULL_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getMyProfileSnapshot(REQUEST_WITH_CTX);
    expect(response).toEqual({ profile: null });
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PROFILE_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.getMyProfileSnapshot({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stub.lastOptions).toBeNull();
  });

  it('translates downstream timeout to 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = buildController(stub);

    await expect(c.getMyProfileSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('translates downstream network_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'network_error',
      detail: 'connection refused',
    });
    const c = buildController(stub);

    await expect(c.getMyProfileSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('translates downstream server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getMyProfileSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('translates not_configured to 503', async () => {
    const stub = new StubDownstreamClient({
      kind: 'not_configured',
      service: 'provider',
    });
    const c = buildController(stub);

    await expect(c.getMyProfileSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('forwards a downstream 4xx verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Internal authentication required.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 401,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getMyProfileSnapshot(REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 401,
      response: downstreamBody,
    });
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { totally: 'wrong' },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getMyProfileSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// getProfileById()    (TS-200-followup-4)
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.getProfileById', () => {
  it('returns the bare record + URL-encodes the providerId', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PROFILE_RECORD,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getProfileById('prv_abc', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_PROFILE_RECORD);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/profile');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
  });

  it('URL-encodes a providerId carrying slash characters (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PROFILE_RECORD,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.getProfileById('prv/../admin', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv%2F..%2Fadmin/profile');
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PROFILE_RECORD,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.getProfileById('prv_abc', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 404 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No provider with id prv_missing.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getProfileById('prv_missing', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 404,
      response: downstreamBody,
    });
  });

  it('translates downstream server_error to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'server_error',
      status: 500,
      body: null,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getProfileById('prv_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { id: 'prv_abc' },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getProfileById('prv_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// updateProfile()
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.updateProfile', () => {
  it('forwards the validated body + Idempotency-Key + URL-encoded providerId', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.updateProfile(
      'prv_abc',
      VALID_UPDATE_PROFILE_BODY,
      'profile-update-001',
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_UPDATE_PROFILE_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/profile');
    expect(stub.lastOptions?.body).toEqual(VALID_UPDATE_PROFILE_BODY);
    expect(stub.lastOptions?.idempotencyKey).toBe('profile-update-001');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
    // If-Match absent → no extraHeaders forwarded.
    expect(stub.lastOptions?.extraHeaders).toBeUndefined();
  });

  it('omits Idempotency-Key when the inbound header is absent', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updateProfile(
      'prv_abc',
      VALID_UPDATE_PROFILE_BODY,
      undefined,
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown body field (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateProfile(
        'prv_abc',
        { ...VALID_UPDATE_PROFILE_BODY, smuggled: 'oops' },
        undefined,
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a malformed language tag at the gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateProfile(
        'prv_abc',
        { ...VALID_UPDATE_PROFILE_BODY, languages: ['English with spaces'] },
        undefined,
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a duplicate tag inside one kind', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateProfile(
        'prv_abc',
        { ...VALID_UPDATE_PROFILE_BODY, cuisines: ['italian', 'italian'] },
        undefined,
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('URL-encodes a slash-injection providerId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updateProfile(
      'prv/../admin',
      VALID_UPDATE_PROFILE_BODY,
      undefined,
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv%2F..%2Fadmin/profile');
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateProfile('prv_abc', VALID_UPDATE_PROFILE_BODY, undefined, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 403 verbatim (row-ownership rejected)', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Provider profile is owned by a different user.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateProfile('prv_abc', VALID_UPDATE_PROFILE_BODY, undefined, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403, response: downstreamBody });
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { profile: { malformed: true } },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateProfile('prv_abc', VALID_UPDATE_PROFILE_BODY, undefined, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  // ─── If-Match (TS-200-followup-5) ──────────────────────────────────
  it('forwards a quoted If-Match header verbatim via extraHeaders', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updateProfile(
      'prv_abc',
      VALID_UPDATE_PROFILE_BODY,
      undefined,
      '"2026-05-20T12:00:01.000Z"',
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.extraHeaders).toEqual({
      'if-match': '"2026-05-20T12:00:01.000Z"',
    });
  });

  it('omits extraHeaders when If-Match is an empty string', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PROFILE_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updateProfile('prv_abc', VALID_UPDATE_PROFILE_BODY, undefined, '', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.extraHeaders).toBeUndefined();
  });

  it('forwards a downstream 412 (precondition_failed) verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Precondition Failed',
      status: 412,
      detail: 'The profile has been updated since you loaded it. Refresh and try again.',
      currentUpdatedAt: '2026-05-20T12:30:00.000Z',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 412,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateProfile(
        'prv_abc',
        VALID_UPDATE_PROFILE_BODY,
        undefined,
        '"2026-05-20T12:00:00.000Z"',
        REQUEST_WITH_CTX,
      ),
    ).rejects.toMatchObject({ status: 412, response: downstreamBody });
  });
});

// ─────────────────────────────────────────────────────────────────────
// getMyAvailabilitySnapshot()    (TS-203)
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.getMyAvailabilitySnapshot', () => {
  it('returns the parsed snapshot + forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_AVAILABILITY_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getMyAvailabilitySnapshot(REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_AVAILABILITY_SNAPSHOT_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/me/availability-snapshot');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
  });

  it('passes through the null-availability snapshot (empty-state placeholder)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_AVAILABILITY_SNAPSHOT_NULL_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getMyAvailabilitySnapshot(REQUEST_WITH_CTX);
    expect(response).toEqual({ availability: null });
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_AVAILABILITY_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.getMyAvailabilitySnapshot({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { availability: { totally: 'wrong' } },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getMyAvailabilitySnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// updateAvailability()    (TS-203)
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.updateAvailability', () => {
  it('forwards the validated body + Idempotency-Key + URL-encoded providerId', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.updateAvailability(
      'prv_abc',
      VALID_UPDATE_AVAILABILITY_BODY,
      'availability-update-001',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_UPDATE_AVAILABILITY_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/availability');
    expect(stub.lastOptions?.body).toEqual(VALID_UPDATE_AVAILABILITY_BODY);
    expect(stub.lastOptions?.idempotencyKey).toBe('availability-update-001');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
  });

  it('omits Idempotency-Key when the inbound header is absent', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updateAvailability(
      'prv_abc',
      VALID_UPDATE_AVAILABILITY_BODY,
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('rejects an unknown body field (strict)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateAvailability(
        'prv_abc',
        { ...VALID_UPDATE_AVAILABILITY_BODY, smuggled: 'oops' },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects overlapping windows on the same weekday at the gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateAvailability(
        'prv_abc',
        {
          windows: [
            { weekday: 'monday' as const, startTime: '09:00', endTime: '13:00' },
            { weekday: 'monday' as const, startTime: '12:00', endTime: '14:00' },
          ],
          exceptions: [],
        },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects duplicate exception dates at the gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateAvailability(
        'prv_abc',
        {
          windows: [],
          exceptions: [{ date: '2026-12-25' }, { date: '2026-12-25' }],
        },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a malformed time (HH:MM regex) at the gateway', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateAvailability(
        'prv_abc',
        {
          windows: [{ weekday: 'monday' as const, startTime: '9:00', endTime: '13:00' }],
          exceptions: [],
        },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateAvailability('prv_abc', VALID_UPDATE_AVAILABILITY_BODY, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 403 verbatim (row-ownership rejected)', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'Provider availability is owned by a different user.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateAvailability('prv_abc', VALID_UPDATE_AVAILABILITY_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403, response: downstreamBody });
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { availability: { malformed: true } },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateAvailability('prv_abc', VALID_UPDATE_AVAILABILITY_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// deleteAvailability()    (TS-203)
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.deleteAvailability', () => {
  it('forwards the providerId + Idempotency-Key and returns the response', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.deleteAvailability(
      'prv_abc',
      'availability-delete-001',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_DELETE_AVAILABILITY_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/availability');
    expect(stub.lastOptions?.idempotencyKey).toBe('availability-delete-001');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
  });

  it('omits Idempotency-Key when the inbound header is absent', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.deleteAvailability('prv_abc', undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('URL-encodes a slash-injection providerId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.deleteAvailability('prv/../admin', undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv%2F..%2Fadmin/availability');
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_AVAILABILITY_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.deleteAvailability('prv_abc', undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 404 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'No provider with id prv_missing.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.deleteAvailability('prv_missing', undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 404, response: downstreamBody });
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { providerId: 'prv_abc' },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.deleteAvailability('prv_abc', undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Service areas (TS-202)
// ─────────────────────────────────────────────────────────────────────

const VALID_POLYGON = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [-73.96, 40.77],
      [-73.95, 40.77],
      [-73.95, 40.78],
      [-73.96, 40.78],
      [-73.96, 40.77],
    ],
  ],
};

const VALID_SERVICE_AREA_RECORD = {
  id: 'psa_1',
  providerId: 'prv_abc',
  label: 'Upper East Side',
  polygon: VALID_POLYGON,
  centroid: { latitude: 40.775, longitude: -73.955 },
  boundingBox: {
    minLatitude: 40.77,
    minLongitude: -73.96,
    maxLatitude: 40.78,
    maxLongitude: -73.95,
  },
  createdAt: NOW_ISO,
  updatedAt: NOW_ISO,
};

const VALID_SERVICE_AREAS_SNAPSHOT_RESPONSE = {
  providerId: 'prv_abc',
  serviceAreas: [VALID_SERVICE_AREA_RECORD],
};

const VALID_SERVICE_AREAS_SNAPSHOT_NULL_RESPONSE = {
  providerId: null,
  serviceAreas: null,
};

const VALID_UPDATE_SERVICE_AREAS_BODY = {
  serviceAreas: [{ label: 'Upper East Side', polygon: VALID_POLYGON }],
};

const VALID_UPDATE_SERVICE_AREAS_RESPONSE = {
  serviceAreas: [VALID_SERVICE_AREA_RECORD],
};

const VALID_DELETE_SERVICE_AREAS_RESPONSE = {
  providerId: 'prv_abc',
  deletedCount: 2,
};

describe('ProvidersProxyController.getMyServiceAreasSnapshot', () => {
  it('returns the parsed snapshot + forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SERVICE_AREAS_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getMyServiceAreasSnapshot(REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_SERVICE_AREAS_SNAPSHOT_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/me/service-areas-snapshot');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
  });

  it('passes through the null snapshot (no provider row yet)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SERVICE_AREAS_SNAPSHOT_NULL_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getMyServiceAreasSnapshot(REQUEST_WITH_CTX);
    expect(response.serviceAreas).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_SERVICE_AREAS_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.getMyServiceAreasSnapshot({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { serviceAreas: [{ id: 'psa_1' }] },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getMyServiceAreasSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('maps not_configured → 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'provider' });
    const c = buildController(stub);

    await expect(c.getMyServiceAreasSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('ProvidersProxyController.updateServiceAreas', () => {
  it('forwards the validated body + Idempotency-Key + actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_SERVICE_AREAS_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.updateServiceAreas(
      'prv_abc',
      VALID_UPDATE_SERVICE_AREAS_BODY,
      'areas-001',
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_UPDATE_SERVICE_AREAS_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/service-areas');
    expect(stub.lastOptions?.idempotencyKey).toBe('areas-001');
    expect(stub.lastOptions?.body).toEqual(VALID_UPDATE_SERVICE_AREAS_BODY);
  });

  it('accepts an empty serviceAreas array (clear-all)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { serviceAreas: [] },
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.updateServiceAreas(
      'prv_abc',
      { serviceAreas: [] },
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(response.serviceAreas).toEqual([]);
  });

  it('rejects a malformed (unclosed-ring) polygon with 400 before any downstream call', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_SERVICE_AREAS_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateServiceAreas(
        'prv_abc',
        {
          serviceAreas: [
            {
              polygon: {
                type: 'Polygon',
                coordinates: [
                  [
                    [-73.96, 40.77],
                    [-73.95, 40.77],
                    [-73.95, 40.78],
                  ],
                ],
              },
            },
          ],
        },
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('URL-encodes a slash-injection providerId (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_SERVICE_AREAS_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updateServiceAreas(
      'prv/../admin',
      VALID_UPDATE_SERVICE_AREAS_BODY,
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv%2F..%2Fadmin/service-areas');
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_SERVICE_AREAS_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateServiceAreas('prv_abc', VALID_UPDATE_SERVICE_AREAS_BODY, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('forwards a downstream 403 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'You may only edit your own provider service areas.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 403,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updateServiceAreas('prv_abc', VALID_UPDATE_SERVICE_AREAS_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403, response: downstreamBody });
  });

  it('maps a downstream timeout → 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = buildController(stub);

    await expect(
      c.updateServiceAreas('prv_abc', VALID_UPDATE_SERVICE_AREAS_BODY, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });
});

describe('ProvidersProxyController.deleteServiceAreas', () => {
  it('forwards the DELETE + Idempotency-Key + actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_SERVICE_AREAS_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.deleteServiceAreas('prv_abc', 'areas-del-001', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_DELETE_SERVICE_AREAS_RESPONSE);
    expect(stub.lastOptions?.method).toBe('DELETE');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/service-areas');
    expect(stub.lastOptions?.idempotencyKey).toBe('areas-del-001');
  });

  it('omits Idempotency-Key when the inbound header is absent', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_SERVICE_AREAS_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.deleteServiceAreas('prv_abc', undefined, REQUEST_WITH_CTX);
    expect(stub.lastOptions?.idempotencyKey).toBeUndefined();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_DELETE_SERVICE_AREAS_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.deleteServiceAreas('prv_abc', undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('maps a network_error → 502', async () => {
    const stub = new StubDownstreamClient({ kind: 'network_error', detail: 'ECONNREFUSED' });
    const c = buildController(stub);

    await expect(
      c.deleteServiceAreas('prv_abc', undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// getMyPricingSnapshot()    (TS-204)
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.getMyPricingSnapshot', () => {
  it('returns the parsed snapshot + forwards the actor', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PRICING_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getMyPricingSnapshot(REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_PRICING_SNAPSHOT_RESPONSE);
    expect(stub.lastOptions?.service).toBe('provider');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/me/pricing-snapshot');
    expect(stub.lastOptions?.method).toBe('GET');
    expect(stub.lastOptions?.actor?.userId).toBe('usr_provider');
  });

  it('passes through the null-pricing snapshot (no provider row yet)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PRICING_SNAPSHOT_NULL_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    expect(await c.getMyPricingSnapshot(REQUEST_WITH_CTX)).toEqual({ pricing: null });
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PRICING_SNAPSHOT_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.getMyPricingSnapshot({ headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stub.lastOptions).toBeNull();
  });

  it('translates a contract-violating downstream body to 502', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: { totally: 'wrong' },
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getMyPricingSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('translates not_configured → 503', async () => {
    const stub = new StubDownstreamClient({ kind: 'not_configured', service: 'provider' });
    const c = buildController(stub);

    await expect(c.getMyPricingSnapshot(REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// getPricingById()    (TS-204)
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.getPricingById', () => {
  it('returns the bare record + URL-encodes the providerId', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PRICING_RECORD,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.getPricingById('prv_abc', REQUEST_WITH_CTX);
    expect(response).toEqual(VALID_PRICING_RECORD);
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/pricing');
    expect(stub.lastOptions?.method).toBe('GET');
  });

  it('URL-encodes a providerId carrying slash characters (path-traversal defence)', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PRICING_RECORD,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.getPricingById('prv/../admin', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv%2F..%2Fadmin/pricing');
  });

  it('forwards a downstream 404 verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Provider not found.',
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 404,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(c.getPricingById('ghost', REQUEST_WITH_CTX)).rejects.toMatchObject({
      status: 404,
      response: downstreamBody,
    });
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_PRICING_RECORD,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.getPricingById('prv_abc', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ─────────────────────────────────────────────────────────────────────
// updatePricing()    (TS-204)
// ─────────────────────────────────────────────────────────────────────

describe('ProvidersProxyController.updatePricing', () => {
  it('forwards the validated body + Idempotency-Key + URL-encodes the path', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PRICING_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    const response = await c.updatePricing(
      'prv_abc',
      VALID_UPDATE_PRICING_BODY,
      'pricing-update-001',
      undefined,
      REQUEST_WITH_CTX,
    );
    expect(response).toEqual(VALID_UPDATE_PRICING_RESPONSE);
    expect(stub.lastOptions?.method).toBe('PUT');
    expect(stub.lastOptions?.path).toBe('/api/v1/providers/prv_abc/pricing');
    expect(stub.lastOptions?.body).toEqual(VALID_UPDATE_PRICING_BODY);
    expect(stub.lastOptions?.idempotencyKey).toBe('pricing-update-001');
    // If-Match absent → no extraHeaders forwarded.
    expect(stub.lastOptions?.extraHeaders).toBeUndefined();
  });

  it('forwards a quoted If-Match header verbatim via extraHeaders', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PRICING_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updatePricing(
      'prv_abc',
      VALID_UPDATE_PRICING_BODY,
      undefined,
      '"2026-05-25T12:00:00.000Z"',
      REQUEST_WITH_CTX,
    );
    expect(stub.lastOptions?.extraHeaders).toEqual({
      'if-match': '"2026-05-25T12:00:00.000Z"',
    });
  });

  it('omits extraHeaders when If-Match is an empty string', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PRICING_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await c.updatePricing('prv_abc', VALID_UPDATE_PRICING_BODY, undefined, '', REQUEST_WITH_CTX);
    expect(stub.lastOptions?.extraHeaders).toBeUndefined();
  });

  it('rejects an unknown body field (strict) with 400 before any downstream call', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PRICING_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updatePricing(
        'prv_abc',
        { ...VALID_UPDATE_PRICING_BODY, smuggled: 'oops' },
        undefined,
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('rejects a non-integer rate (contract validation) before any downstream call', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PRICING_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updatePricing(
        'prv_abc',
        { hourlyRateMinor: 75.5, currency: 'USD' },
        undefined,
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toBeInstanceOf(HttpException);
    expect(stub.lastOptions).toBeNull();
  });

  it('forwards a downstream 422 (out-of-band) verbatim', async () => {
    const downstreamBody = {
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'Hourly rate must be between 6000 and 12000 minor units for the certified tier.',
      tier: 'certified',
      minHourlyRateMinor: 6000,
      maxHourlyRateMinor: 12000,
    };
    const stub = new StubDownstreamClient({
      kind: 'client_error',
      status: 422,
      body: downstreamBody,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updatePricing(
        'prv_abc',
        { hourlyRateMinor: 5000, currency: 'USD' },
        undefined,
        undefined,
        REQUEST_WITH_CTX,
      ),
    ).rejects.toMatchObject({ status: 422, response: downstreamBody });
  });

  it('throws 401 when no requestContext is attached', async () => {
    const stub = new StubDownstreamClient({
      kind: 'ok',
      status: 200,
      body: VALID_UPDATE_PRICING_RESPONSE,
      setCookies: [],
    });
    const c = buildController(stub);

    await expect(
      c.updatePricing('prv_abc', VALID_UPDATE_PRICING_BODY, undefined, undefined, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stub.lastOptions).toBeNull();
  });

  it('maps a downstream timeout → 504', async () => {
    const stub = new StubDownstreamClient({ kind: 'timeout' });
    const c = buildController(stub);

    await expect(
      c.updatePricing('prv_abc', VALID_UPDATE_PRICING_BODY, undefined, undefined, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });
});
