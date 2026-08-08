import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { SeniorConsentResponse, WellnessAnomalyResponse } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';

import { WellnessAnomalyAggregatorController } from './wellness-anomaly-aggregator.controller';

/**
 * WellnessAnomalyAggregatorController tests (TS-236).
 *
 * Same two-hop shape as the TS-231 wellness-trends aggregator:
 *   1. service-household → the senior's consent record (membership gate)
 *   2. service-booking → the decline flags (only when the caller may see
 *      the `notes` surface)
 *
 * Tests cover the consent gate, membership propagation, query validation,
 * per-upstream failure modes, the no-context 401, and the downstream call
 * shapes (paths, actor, windowDays forwarding).
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

const ANOMALIES: WellnessAnomalyResponse = {
  seniorId: 'snr_abc',
  windowDays: 30,
  totalCompletedVisits: 5,
  flags: [
    {
      metric: 'appetite',
      severity: 'high',
      baselineScore: 5,
      recentScore: 2,
      drop: 3,
      latestLevel: 'minimal',
      latestVisitDate: '2026-05-26T17:00:00.000Z',
      observationCount: 5,
    },
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

function buildController(scripted: ScriptedDownstream): WellnessAnomalyAggregatorController {
  return new WellnessAnomalyAggregatorController(scripted as unknown as DownstreamHttpClient);
}

describe('WellnessAnomalyAggregatorController.getWellnessAnomalies', () => {
  it('manager (canManage) sees flags — calls booking and returns shared:true', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: ANOMALIES, setCookies: [] },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(true);
    expect(response.seniorId).toBe('snr_abc');
    expect(response.totalCompletedVisits).toBe(5);
    expect(response.flags).toHaveLength(1);
    expect(response.flags[0]?.metric).toBe('appetite');
    expect(response.flags[0]?.severity).toBe('high');
    expect(scripted.calls).toHaveLength(2);
  });

  it('observer with notes consent sees flags', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: false, notes: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: ANOMALIES, setCookies: [] },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(true);
    expect(response.flags).toHaveLength(1);
  });

  it('observer WITHOUT notes consent gets shared:false + empty flags and NO booking call', async () => {
    const scripted = new ScriptedDownstream([
      {
        kind: 'ok',
        status: 200,
        body: consent({ canManage: false, notes: false }),
        setCookies: [],
      },
    ]);
    const c = buildController(scripted);

    const response = await c.getWellnessAnomalies('snr_abc', { windowDays: 90 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(false);
    expect(response.flags).toEqual([]);
    expect(response.totalCompletedVisits).toBe(0);
    expect(response.windowDays).toBe(90);
    // Critical: the booking call never fires — nothing crosses.
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

    const response = await c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX);

    expect(response.shared).toBe(false);
    expect(scripted.calls).toHaveLength(1);
  });

  it('issues the two downstream calls with the right paths, actor + forwarded window', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: ANOMALIES, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await c.getWellnessAnomalies('snr abc', { windowDays: 90 }, REQUEST_WITH_CTX);

    expect(scripted.calls[0]?.service).toBe('household');
    expect(scripted.calls[0]?.path).toBe('/api/v1/seniors/snr%20abc/consent');
    expect(scripted.calls[0]?.actor?.userId).toBe('usr_family_abc');
    expect(scripted.calls[1]?.service).toBe('booking');
    expect(scripted.calls[1]?.path).toBe(
      '/api/v1/bookings/seniors/snr%20abc/wellness-anomalies?windowDays=90',
    );
    expect(scripted.calls[1]?.actor?.userId).toBe('usr_family_abc');
  });

  it('propagates a consent 403 (non-member) verbatim', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 403, body: { detail: 'not a member' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403 });
    expect(scripted.calls).toHaveLength(1);
  });

  it('propagates a consent 404 (missing senior) verbatim', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 404, body: { detail: 'not found' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('maps a malformed consent body to 502', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: { not: 'a consent record' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a malformed booking body to 502', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'ok', status: 200, body: { flags: 'nope' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a booking 4xx to 502 (the gateway already authorised the caller)', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'client_error', status: 400, body: { detail: 'bad window' }, setCookies: [] },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a booking timeout to 504', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'timeout' },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a household not_configured to 503', async () => {
    const scripted = new ScriptedDownstream([{ kind: 'not_configured', service: 'household' }]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a booking not_configured to 503', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: consent({ canManage: true }), setCookies: [] },
      { kind: 'not_configured', service: 'booking' },
    ]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('throws 400 for a malformed query and makes no downstream call', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 7 }, REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 400 });
    expect(scripted.calls).toHaveLength(0);
  });

  it('throws 401 when no request context is present', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);

    await expect(
      c.getWellnessAnomalies('snr_abc', { windowDays: 30 }, {
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

    const response = await c.getWellnessAnomalies('snr_abc', {}, REQUEST_WITH_CTX);
    expect(response.windowDays).toBe(30);
  });
});
