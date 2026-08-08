import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SeniorConsentResponse, WellnessTrendsResponse } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { WellnessTrendsAggregatorController } from './wellness-trends-aggregator.controller';

/**
 * WellnessTrendsAggregatorController tests (TS-231).
 *
 * The controller orchestrates up to two downstream calls:
 *   1. service-household → the senior's consent record (also the
 *      membership gate)
 *   2. service-booking → the per-visit wellness-trend series (only when
 *      the caller may see the `notes` surface)
 *
 * Tests cover: the consent gate (manager sees; observer-with-notes-
 * consent sees; observer-without gets `shared:false` + no booking call);
 * membership propagation (403 / 404 verbatim); query validation (400);
 * per-upstream failure modes (502 / 503 / 504); 401 with no context; and
 * the downstream call shapes (paths, actor, windowDays forwarding).
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

const TRENDS: WellnessTrendsResponse = {
  seniorId: 'snr_abc',
  windowDays: 30,
  totalCompletedVisits: 2,
  series: [
    {
      metric: 'mood',
      points: [
        {
          bookingId: 'bkg_1',
          visitDate: '2026-05-20T17:00:00.000Z',
          recordedAt: '2026-05-20T18:00:00.000Z',
          level: 'bright',
          score: 4,
        },
      ],
      latestScore: 4,
      visitsRecorded: 1,
    },
    { metric: 'appetite', points: [], latestScore: null, visitsRecorded: 0 },
    { metric: 'hydration', points: [], latestScore: null, visitsRecorded: 0 },
    { metric: 'social_engagement', points: [], latestScore: null, visitsRecorded: 0 },
  ],
  generatedAt: '2026-05-27T12:00:00.000Z',
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

function buildController(scripted: ScriptedDownstream): WellnessTrendsAggregatorController {
  return new WellnessTrendsAggregatorController(scripted as unknown as DownstreamHttpClient);
}

describe('WellnessTrendsAggregatorController.getWellnessTrends', () => {
  it('manager (canManage) sees trends — calls booking and returns shared:true', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: TRENDS, setCookies: [] },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(true);
    expect(response.seniorId).toBe('snr_abc');
    expect(response.totalCompletedVisits).toBe(2);
    expect(response.series).toHaveLength(4);
    expect(response.series[0]?.metric).toBe('mood');
    expect(response.series[0]?.points[0]?.score).toBe(4);
    expect(scripted.calls).toHaveLength(2);
  });

  it('observer with notes consent sees trends', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: false, notes: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: TRENDS, setCookies: [] },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(true);
    expect(response.series).toHaveLength(4);
  });

  it('observer WITHOUT notes consent gets shared:false + empty series and NO booking call', async () => {
    const scripted = new ScriptedDownstream([
      {
        kind: 'ok',
        status: 200,
        body: consent({ canManage: false, notes: false }),
        setCookies: [],
      },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessTrends('snr_abc', { windowDays: 90 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(false);
    expect(response.series).toEqual([]);
    expect(response.totalCompletedVisits).toBe(0);
    expect(response.windowDays).toBe(90);
    // Critical: the booking call never fires — the observations never cross.
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]?.service).toBe('household');
  });

  it('an unrelated photos-only consent does NOT unlock the notes surface', async () => {
    const scripted = new ScriptedDownstream([
      {
        kind: 'ok',
        status: 200,
        body: consent({ canManage: false, photos: true, notes: false }),
        setCookies: [],
      },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(false);
    expect(scripted.calls).toHaveLength(1);
  });

  it('issues the two downstream calls with the right paths, actor + forwarded window', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: TRENDS, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await c.getWellnessTrends('snr abc', { windowDays: 90 }, REQUEST_WITH_CTX);

    expect(scripted.calls[0]?.service).toBe('household');
    expect(scripted.calls[0]?.path).toBe('/api/v1/seniors/snr%20abc/consent');
    expect(scripted.calls[0]?.actor?.userId).toBe('usr_family_abc');
    expect(scripted.calls[1]?.service).toBe('booking');
    expect(scripted.calls[1]?.path).toBe(
      '/api/v1/bookings/seniors/snr%20abc/wellness-trends?windowDays=90',
    );
    expect(scripted.calls[1]?.actor?.userId).toBe('usr_family_abc');
  });

  it('propagates a consent 403 (non-member) verbatim', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 403, body: { detail: 'not a member' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403 });
    expect(scripted.calls).toHaveLength(1);
  });

  it('propagates a consent 404 (missing senior) verbatim', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 404, body: { detail: 'not found' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('maps a malformed consent body to 502', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: { not: 'a consent record' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a malformed booking body to 502', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: { series: 'nope' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a booking 4xx to 502 (the gateway already authorised the caller)', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'client_error', status: 400, body: { detail: 'bad window' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a booking timeout to 504', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'timeout' },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a household not_configured to 503', async () => {
    const scripted = new ScriptedDownstream([{ kind: 'not_configured', service: 'household' }]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a booking not_configured to 503', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'not_configured', service: 'booking' },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws 400 for a malformed query and makes no downstream call', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 7 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 400 });
    expect(scripted.calls).toHaveLength(0);
  });

  it('throws 401 when no request context is present', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessTrends('snr_abc', { windowDays: 30 }, {
        headers: {},
      } as unknown as RequestWithContext),
    ).rejects.toMatchObject({ status: 401 });
    expect(scripted.calls).toHaveLength(0);
  });

  it('defaults windowDays to 30 when the query omits it', async () => {
    const scripted = new ScriptedDownstream([
      {
        kind: 'ok',
        status: 200,
        body: consent({ canManage: false, notes: false }),
        setCookies: [],
      },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessTrends('snr_abc', {}, REQUEST_WITH_CTX);
    expect(response.windowDays).toBe(30);
  });
});
