import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { SeniorConsentResponse, SeniorPhotoGalleryResponse } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { SeniorPhotosAggregatorController } from './senior-photos-aggregator.controller';

/**
 * SeniorPhotosAggregatorController tests (TS-232).
 *
 * The controller orchestrates up to two downstream calls:
 *   1. service-household → the senior's consent record (also the
 *      membership gate)
 *   2. service-media → the senior's ready senior_photo assets (only when
 *      the caller may see them)
 *
 * Tests cover: the consent gate (manager sees; observer-with-consent
 * sees; observer-without-consent gets `shared:false` + no media call);
 * membership propagation (403 / 404 verbatim); query validation (400);
 * per-upstream failure modes (502 / 503 / 504); 401 with no context; and
 * the downstream call shapes (paths, actor, limit/cursor forwarding).
 */

function consent(overrides: Partial<SeniorConsentResponse> = {}): SeniorConsentResponse {
  return {
    seniorId: 'snr_abc',
    photos: false,
    notes: false,
    location: false,
    health: false,
    updatedAt: null,
    updatedByUserId: null,
    canManage: false,
    ...overrides,
  };
}

const GALLERY: SeniorPhotoGalleryResponse = {
  seniorId: 'snr_abc',
  photos: [
    {
      id: 'm_1',
      signedDeliveryUrl: 'https://stub-delivery.tasteandsee.example.com/m_1?sig=a',
      signedDeliveryUrlExpiresAt: '2026-05-27T12:05:00.000Z',
      width: 1600,
      height: 1200,
      declaredFileName: 'grandma.jpg',
      createdAt: '2026-05-27T12:00:00.000Z',
    },
  ],
  nextCursor: 'cursor-1',
};

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_family_abc',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'household', tenantId: 'hh_abc' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

class ScriptedDownstream {
  public calls: DownstreamCallOptions[] = [];
  private idx = 0;

  constructor(private readonly results: DownstreamResult[]) {}

  async call<TBody = unknown>(options: DownstreamCallOptions): Promise<DownstreamResult<TBody>> {
    this.calls.push(options);
    const result = this.results[this.idx];
    this.idx += 1;
    if (result === undefined) {
      throw new Error(`ScriptedDownstream ran out of canned results at index ${this.idx - 1}`);
    }
    return result as DownstreamResult<TBody>;
  }
}

function buildController(scripted: ScriptedDownstream): SeniorPhotosAggregatorController {
  return new SeniorPhotosAggregatorController(scripted as unknown as DownstreamHttpClient);
}

describe('SeniorPhotosAggregatorController.getSeniorPhotos', () => {
  it('manager (canManage) sees photos — calls media and returns shared:true', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: GALLERY, setCookies: [] },
    ]);
    const c = buildController(scripted);

    const response = await c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(true);
    expect(response.seniorId).toBe('snr_abc');
    expect(response.photos).toHaveLength(1);
    expect(response.photos[0]?.id).toBe('m_1');
    expect(response.nextCursor).toBe('cursor-1');
    expect(scripted.calls).toHaveLength(2);
  });

  it('observer with photos consent sees photos', async () => {
    const scripted = new ScriptedDownstream([
      {
        kind: 'ok',
        status: 200,
        body: consent({ canManage: false, photos: true }),
        setCookies: [],
      },
      { kind: 'ok', status: 200, body: GALLERY, setCookies: [] },
    ]);
    const c = buildController(scripted);

    const response = await c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(true);
    expect(response.photos).toHaveLength(1);
  });

  it('observer WITHOUT photos consent gets shared:false + empty gallery and NO media call', async () => {
    const scripted = new ScriptedDownstream([
      {
        kind: 'ok',
        status: 200,
        body: consent({ canManage: false, photos: false }),
        setCookies: [],
      },
    ]);
    const c = buildController(scripted);

    const response = await c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(false);
    expect(response.photos).toEqual([]);
    expect(response.nextCursor).toBeNull();
    // Critical: the media call never fires — the photos never cross.
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]?.service).toBe('household');
  });

  it('issues the two downstream calls with the right paths, actor + forwarded limit/cursor', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: GALLERY, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await c.getSeniorPhotos('snr abc', { limit: 12, cursor: 'cur-1' }, REQUEST_WITH_CTX);

    expect(scripted.calls[0]?.service).toBe('household');
    expect(scripted.calls[0]?.path).toBe('/api/v1/seniors/snr%20abc/consent');
    expect(scripted.calls[0]?.actor?.userId).toBe('usr_family_abc');
    expect(scripted.calls[1]?.service).toBe('media');
    expect(scripted.calls[1]?.path).toBe(
      '/api/v1/media/seniors/snr%20abc/photos?limit=12&cursor=cur-1',
    );
    expect(scripted.calls[1]?.actor?.userId).toBe('usr_family_abc');
  });

  it('propagates a consent 403 (non-member) verbatim', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 403, body: { detail: 'not a member' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403 });
    expect(scripted.calls).toHaveLength(1);
  });

  it('propagates a consent 404 (missing senior) verbatim', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 404, body: { detail: 'not found' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('maps a malformed consent body to 502', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: { not: 'a consent record' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a malformed media body to 502', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: { photos: 'nope' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a media 4xx to 502 (the gateway already authorised the caller)', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'client_error', status: 400, body: { detail: 'bad cursor' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a media timeout to 504', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'timeout' },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a household not_configured to 503', async () => {
    const scripted = new ScriptedDownstream([{ kind: 'not_configured', service: 'household' }]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a media not_configured to 503', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'not_configured', service: 'media' },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws 400 for a malformed query and makes no downstream call', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 9999 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 400 });
    expect(scripted.calls).toHaveLength(0);
  });

  it('rejects an unknown query field (.strict) with 400', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24, foo: 'bar' }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(HttpException);
    expect(scripted.calls).toHaveLength(0);
  });

  it('throws Unauthorized when no requestContext is attached', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);

    await expect(
      c.getSeniorPhotos('snr_abc', { limit: 24 }, { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
