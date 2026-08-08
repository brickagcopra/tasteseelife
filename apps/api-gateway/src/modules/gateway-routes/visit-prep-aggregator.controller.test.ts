import {
  BadGatewayException,
  ForbiddenException,
  GatewayTimeoutException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env';
import type {
  DownstreamCallOptions,
  DownstreamHttpClient,
  DownstreamResult,
} from '../service-registry/services/downstream-http-client';
import { VisitPrepAggregatorController } from './visit-prep-aggregator.controller';

/**
 * VisitPrepAggregatorController tests (TS-208).
 *
 * The controller orchestrates three downstream calls:
 *   1. service-booking → booking row
 *   2. service-provider → actor's own provider profile snapshot
 *   3. service-household → senior operational profile + memory recipes
 *
 * Tests cover:
 *   - 503 when the gateway is missing the household shared secret
 *   - happy path: all three calls succeed, aggregator returns the
 *     full VisitPrepChecklistResponse with the correct field set
 *   - the household call carries the shared-secret extraHeaders
 *   - per-call failure modes: booking 404 / provider null / authz
 *     mismatch / household 404 / various 502 surfaces / 504 timeout /
 *     not-configured 503
 *   - 401 when the request has no context
 */

const VALID_BOOKING = {
  id: 'bkg_1',
  householdId: 'hh_abc',
  seniorId: 'snr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining' as const,
  status: 'confirmed' as const,
  scheduledStart: '2026-06-10T17:00:00.000Z',
  scheduledEnd: '2026-06-10T19:00:00.000Z',
  currency: 'USD',
  basePriceMinor: 15_000,
  commissionRateBps: 2_000,
  commissionAmountMinor: 3_000,
  finalPriceMinor: 15_000,
  bookingNotes: null,
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  cancellationReasonText: null,
  acceptWindowExpiresAt: '2026-05-13T12:30:00.000Z',
  declinedAt: null,
  declineKind: null,
  declineReason: null,
  declineReasonText: null,
  declinedByUserId: null,
  onHold: false,
  createdAt: '2026-05-13T12:00:00.000Z',
  updatedAt: '2026-05-13T12:00:00.000Z',
};

const VALID_PROFILE_SNAPSHOT = {
  profile: {
    id: 'prv_abc',
    status: 'active' as const,
    tier: 'certified' as const,
    displayName: 'Chef A',
    headline: null,
    bio: null,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    dementiaSensitive: true,
    languages: [],
    cuisines: [],
    dietaryExpertise: [],
    createdAt: '2026-05-01T12:00:00.000Z',
    updatedAt: '2026-05-01T12:00:00.000Z',
  },
};

const VALID_HOUSEHOLD_SNAPSHOT = {
  senior: {
    seniorId: 'snr_abc',
    dietaryTags: ['low_sodium', 'soft_textures'],
    allergenTags: ['peanut'],
    languageTags: ['en-US'],
    mobilityLevel: 'aided_cane' as const,
    dementiaStatus: 'mild_cognitive_impairment' as const,
    intakeCompletedAt: '2026-05-01T12:00:00.000Z',
  },
  memoryRecipes: [
    {
      id: 'mr_1',
      seniorId: 'snr_abc',
      title: "Bobchi's pierogi",
      description: 'My grandmother taught me to fold these.',
      source: 'family_contribution' as const,
      cuisineTag: 'eastern_european',
      imageKey: null,
      requestedForUpcomingVisit: true,
      contributedByUserId: 'usr_family_1',
      sortPosition: 0,
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    },
  ],
};

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_provider_abc',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_001' },
} as unknown as RequestWithContext;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
    HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: 'p'.repeat(48),
    ...overrides,
  } as unknown as Env;
}

/**
 * A scripted downstream client that returns canned results in the
 * order the aggregator calls its three upstreams. Captures every call
 * so assertions can pin the path, the actor, and the extra headers.
 */
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

function buildController(
  scripted: ScriptedDownstream,
  env: Env = makeEnv(),
): VisitPrepAggregatorController {
  return new VisitPrepAggregatorController(scripted as unknown as DownstreamHttpClient, env);
}

describe('VisitPrepAggregatorController.getPrepChecklist', () => {
  it('returns 503 when the gateway is missing the household shared secret', async () => {
    const scripted = new ScriptedDownstream([]);
    const env = makeEnv({ HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: undefined });
    const c = buildController(scripted, env);

    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(scripted.calls).toHaveLength(0);
  });

  it('throws Unauthorized when no requestContext is attached', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);
    await expect(
      c.getPrepChecklist('bkg_1', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('happy path — returns the aggregated VisitPrepChecklistResponse', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_PROFILE_SNAPSHOT, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_HOUSEHOLD_SNAPSHOT, setCookies: [] },
    ]);
    const c = buildController(scripted);

    const response = await c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX);

    expect(response.booking.id).toBe('bkg_1');
    expect(response.booking.providerId).toBe('prv_abc');
    expect(response.booking.seniorId).toBe('snr_abc');
    expect(response.booking.acceptWindowExpiresAt).toBe('2026-05-13T12:30:00.000Z');
    expect(response.senior.seniorId).toBe('snr_abc');
    expect(response.senior.dietaryTags).toEqual(['low_sodium', 'soft_textures']);
    expect(response.memoryRecipes).toHaveLength(1);
    expect(response.memoryRecipes[0]?.requestedForUpcomingVisit).toBe(true);
    expect(typeof response.generatedAt).toBe('string');
  });

  it('issues all three downstream calls with the right paths, actor + shared secret', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_PROFILE_SNAPSHOT, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_HOUSEHOLD_SNAPSHOT, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX);

    expect(scripted.calls).toHaveLength(3);
    // 1: service-booking authenticated booking read.
    expect(scripted.calls[0]?.service).toBe('booking');
    expect(scripted.calls[0]?.path).toBe('/api/v1/bookings/bkg_1');
    expect(scripted.calls[0]?.actor?.userId).toBe('usr_provider_abc');
    expect(scripted.calls[0]?.extraHeaders).toBeUndefined();
    // 2: service-provider authenticated profile-snapshot read.
    expect(scripted.calls[1]?.service).toBe('provider');
    expect(scripted.calls[1]?.path).toBe('/api/v1/providers/me/profile-snapshot');
    expect(scripted.calls[1]?.actor?.userId).toBe('usr_provider_abc');
    expect(scripted.calls[1]?.extraHeaders).toBeUndefined();
    // 3: service-household internal shared-secret read; no actor.
    expect(scripted.calls[2]?.service).toBe('household');
    expect(scripted.calls[2]?.path).toBe('/api/v1/internal/seniors/snr_abc/prep-snapshot');
    expect(scripted.calls[2]?.actor).toBeUndefined();
    expect(scripted.calls[2]?.extraHeaders).toEqual({
      'x-household-visit-prep-internal-api-key': 'p'.repeat(48),
    });
  });

  it('propagates a 404 from service-booking as a 404', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 404, body: {}, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_missing', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(scripted.calls).toHaveLength(1);
  });

  it('returns 403 when the actor is not a provider', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      { kind: 'ok', status: 200, body: { profile: null }, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Confirms we stopped before the household call.
    expect(scripted.calls).toHaveLength(2);
  });

  it('returns 403 when the actor IS a provider but not THIS booking provider', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      {
        kind: 'ok',
        status: 200,
        body: {
          profile: { ...VALID_PROFILE_SNAPSHOT.profile, id: 'prv_other' },
        },
        setCookies: [],
      },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Confirms we stopped before the household call.
    expect(scripted.calls).toHaveLength(2);
  });

  it('returns 502 when service-booking returns a malformed body', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: { id: 'bkg_1' }, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('returns 502 when service-provider returns a malformed body', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      { kind: 'ok', status: 200, body: { not: 'a profile-snapshot shape' }, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('returns 502 when service-household returns a malformed body', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_PROFILE_SNAPSHOT, setCookies: [] },
      { kind: 'ok', status: 200, body: { senior: { incomplete: true } }, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('returns 504 when service-booking times out', async () => {
    const scripted = new ScriptedDownstream([{ kind: 'timeout' }]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      GatewayTimeoutException,
    );
  });

  it('returns 502 when service-booking is unreachable', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'network_error', detail: 'connect ECONNREFUSED' },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('returns 503 when service-booking is not configured', async () => {
    const scripted = new ScriptedDownstream([{ kind: 'not_configured', service: 'booking' }]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('returns 404 when service-household reports the senior is missing', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_PROFILE_SNAPSHOT, setCookies: [] },
      { kind: 'client_error', status: 404, body: {}, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns 502 when service-household returns 401 — points to a shared-secret misconfig, not a client problem', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'ok', status: 200, body: VALID_BOOKING, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_PROFILE_SNAPSHOT, setCookies: [] },
      { kind: 'client_error', status: 401, body: {}, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await expect(c.getPrepChecklist('bkg_1', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('URL-encodes the bookingId + seniorId path segments', async () => {
    const scripted = new ScriptedDownstream([
      {
        kind: 'ok',
        status: 200,
        body: {
          ...VALID_BOOKING,
          id: 'bkg with space',
          seniorId: 'snr/funky',
        },
        setCookies: [],
      },
      { kind: 'ok', status: 200, body: VALID_PROFILE_SNAPSHOT, setCookies: [] },
      { kind: 'ok', status: 200, body: VALID_HOUSEHOLD_SNAPSHOT, setCookies: [] },
    ]);
    const c = buildController(scripted);
    await c.getPrepChecklist('bkg with space', REQUEST_WITH_CTX);

    expect(scripted.calls[0]?.path).toBe('/api/v1/bookings/bkg%20with%20space');
    expect(scripted.calls[2]?.path).toBe('/api/v1/internal/seniors/snr%2Ffunky/prep-snapshot');
  });
});
