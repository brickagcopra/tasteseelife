import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
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
import { SeniorRecommendationsAggregatorController } from './senior-recommendations-aggregator.controller';

/**
 * SeniorRecommendationsAggregatorController tests (TS-213).
 *
 * The controller orchestrates three downstream calls:
 *   1. service-household → senior preferences (actor token; authz gate)
 *   2. service-household → operational intake (internal shared secret)
 *   3. service-search    → scoring engine (internal shared secret)
 *
 * Tests cover the shared-secret fail-fast 503s, the happy path + the
 * de-identified profile assembly (no seniorId crosses to search), the
 * call wiring (paths / actor / extraHeaders), the verbatim authz
 * forwarding from the preferences read, and the per-hop failure modes.
 */

const VALID_PREFERENCES = {
  seniorId: 'snr_abc',
  preferences: [
    {
      key: 'favorite_cuisine',
      value: 'Italian, especially Tuscan',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    },
    {
      key: 'regional_tradition',
      value: 'Sunday Sicilian dinners',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    },
    {
      key: 'sunday_ritual',
      value: 'Watches the opera every weekend',
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    },
  ],
};

const VALID_PREP_SNAPSHOT = {
  senior: {
    seniorId: 'snr_abc',
    dietaryTags: ['kosher', 'low_sodium'],
    allergenTags: ['peanut'],
    languageTags: ['en-US', 'es'],
    mobilityLevel: 'aided_cane' as const,
    dementiaStatus: 'mild_cognitive_impairment' as const,
    intakeCompletedAt: '2026-05-01T12:00:00.000Z',
  },
  memoryRecipes: [
    {
      id: 'mr_1',
      seniorId: 'snr_abc',
      title: "Nonna's ragu",
      description: 'A slow Sunday sauce.',
      source: 'family_contribution' as const,
      cuisineTag: 'eastern_european',
      imageKey: null,
      requestedForUpcomingVisit: true,
      contributedByUserId: 'usr_family_abc',
      sortPosition: 0,
      createdAt: '2026-05-01T12:00:00.000Z',
      updatedAt: '2026-05-01T12:00:00.000Z',
    },
  ],
};

function buildDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'prov_abc',
    userId: 'user_abc',
    displayName: 'Chef Rosa',
    headline: null,
    bio: null,
    tier: 'certified',
    status: 'active',
    languages: ['es'],
    specialties: ['dementia_sensitive'],
    cuisines: ['italian'],
    dietaryExpertise: ['kosher'],
    certifications: [],
    centroid: null,
    ratingAverage: 4.8,
    ratingCount: 12,
    completedBookingCount: 30,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    availabilitySummary: null,
    sourceUpdatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

const VALID_RECOMMENDATIONS = {
  recommendations: [
    {
      document: buildDocument(),
      score: 9.5,
      signals: [
        { kind: 'language', matchedValues: ['es'], contribution: 3 },
        { kind: 'dementia_experience', matchedValues: ['dementia_sensitive'], contribution: 4 },
        { kind: 'rating', matchedValues: [], contribution: 0.96 },
      ],
    },
  ],
  liveMode: false,
};

const REQUEST_WITH_CTX: RequestWithContext = {
  requestContext: {
    userId: 'usr_family_abc',
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  },
  headers: { 'x-trace-id': 'tr_test_213' },
} as unknown as RequestWithContext;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    HOUSEHOLD_VISIT_PREP_INTERNAL_HEADER_NAME: 'x-household-visit-prep-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-household-memberships-internal-api-key',
    HOUSEHOLD_SCOPE_CACHE_TTL_SECONDS: 60,
    HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: 'p'.repeat(48),
    SEARCH_INDEX_HEADER_NAME: 'x-internal-api-key',
    SEARCH_INDEX_API_KEY: 'k'.repeat(40),
    ...overrides,
  } as unknown as Env;
}

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
): SeniorRecommendationsAggregatorController {
  return new SeniorRecommendationsAggregatorController(
    scripted as unknown as DownstreamHttpClient,
    env,
  );
}

const ok = (body: unknown): DownstreamResult => ({ kind: 'ok', status: 200, body, setCookies: [] });

describe('SeniorRecommendationsAggregatorController.getRecommendedProviders', () => {
  it('returns 503 when the household shared secret is unset', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(
      scripted,
      makeEnv({ HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY: undefined }),
    );
    await expect(c.getRecommendedProviders('snr_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(scripted.calls).toHaveLength(0);
  });

  it('returns 503 when the search shared secret is unset', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted, makeEnv({ SEARCH_INDEX_API_KEY: undefined }));
    await expect(c.getRecommendedProviders('snr_abc', REQUEST_WITH_CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(scripted.calls).toHaveLength(0);
  });

  it('throws Unauthorized when no requestContext is attached', async () => {
    const scripted = new ScriptedDownstream([]);
    const c = buildController(scripted);
    await expect(
      c.getRecommendedProviders('snr_abc', { headers: {} } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('happy path — returns the aggregated SeniorRecommendedProvidersResponse', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok(VALID_PREP_SNAPSHOT),
      ok(VALID_RECOMMENDATIONS),
    ]);
    const response = await buildController(scripted).getRecommendedProviders(
      'snr_abc',
      REQUEST_WITH_CTX,
    );

    expect(response.seniorId).toBe('snr_abc');
    expect(response.recommendations).toHaveLength(1);
    expect(response.recommendations[0]?.document.providerId).toBe('prov_abc');
    expect(response.recommendations[0]?.signals[0]?.kind).toBe('language');
    expect(typeof response.generatedAt).toBe('string');
    // liveMode is an internal ops detail — dropped from the public response.
    expect((response as Record<string, unknown>).liveMode).toBeUndefined();
  });

  it('issues all three calls with the right paths / actor / shared secrets', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok(VALID_PREP_SNAPSHOT),
      ok(VALID_RECOMMENDATIONS),
    ]);
    await buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX);

    expect(scripted.calls).toHaveLength(3);
    // 1: household preferences read with the actor token (authz gate).
    expect(scripted.calls[0]?.service).toBe('household');
    expect(scripted.calls[0]?.path).toBe('/api/v1/seniors/snr_abc/preferences');
    expect(scripted.calls[0]?.actor?.userId).toBe('usr_family_abc');
    expect(scripted.calls[0]?.extraHeaders).toBeUndefined();
    // 2: household internal prep-snapshot, shared secret, no actor.
    expect(scripted.calls[1]?.service).toBe('household');
    expect(scripted.calls[1]?.path).toBe('/api/v1/internal/seniors/snr_abc/prep-snapshot');
    expect(scripted.calls[1]?.actor).toBeUndefined();
    expect(scripted.calls[1]?.extraHeaders).toEqual({
      'x-household-visit-prep-internal-api-key': 'p'.repeat(48),
    });
    // 3: search internal recommendations, shared secret, POST.
    expect(scripted.calls[2]?.service).toBe('search');
    expect(scripted.calls[2]?.path).toBe('/api/v1/internal/search/recommendations');
    expect(scripted.calls[2]?.method).toBe('POST');
    expect(scripted.calls[2]?.actor).toBeUndefined();
    expect(scripted.calls[2]?.extraHeaders).toEqual({ 'x-internal-api-key': 'k'.repeat(40) });
  });

  it('sends a DE-IDENTIFIED signal profile to service-search (no seniorId / PII)', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok(VALID_PREP_SNAPSHOT),
      ok(VALID_RECOMMENDATIONS),
    ]);
    await buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX);

    const body = scripted.calls[2]?.body as {
      profile: Record<string, unknown>;
      limit: number;
    };
    expect(body.limit).toBe(10);
    expect(body.profile).toEqual({
      // languageTags lower-cased; intake dietary tags passed through.
      languages: ['en-us', 'es'],
      dietaryTags: ['kosher', 'low_sodium'],
      // meal-history affinity: the memory-recipe cuisineTag leads, then
      // the preference free-text cues are mined.
      cuisinePreferences: expect.arrayContaining([
        'eastern_european',
        'italian',
        'tuscan',
        'sicilian',
      ]),
      dementiaSensitive: true,
    });
    // The memory-recipe cuisine tag leads the cuisine cues.
    expect((body.profile.cuisinePreferences as string[])[0]).toBe('eastern_european');
    // Critically: no seniorId / PII fields on the profile.
    expect('seniorId' in body.profile).toBe(false);
  });

  it('marks dementiaSensitive false when the senior intake reports no cognitive needs', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok({
        ...VALID_PREP_SNAPSHOT,
        senior: { ...VALID_PREP_SNAPSHOT.senior, dementiaStatus: 'none' },
      }),
      ok(VALID_RECOMMENDATIONS),
    ]);
    await buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX);
    const body = scripted.calls[2]?.body as { profile: { dementiaSensitive: boolean } };
    expect(body.profile.dementiaSensitive).toBe(false);
  });

  it('forwards a 403 from the preferences read verbatim (non-member authz)', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 403, body: {}, setCookies: [] },
    ]);
    await expect(
      buildController(scripted).getRecommendedProviders('snr_other', REQUEST_WITH_CTX),
    ).rejects.toMatchObject({ status: 403 });
    expect(scripted.calls).toHaveLength(1);
  });

  it('forwards a 404 from the preferences read verbatim (missing senior)', async () => {
    const scripted = new ScriptedDownstream([
      { kind: 'client_error', status: 404, body: {}, setCookies: [] },
    ]);
    let captured: unknown;
    try {
      await buildController(scripted).getRecommendedProviders('snr_ghost', REQUEST_WITH_CTX);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(HttpException);
    expect((captured as HttpException).getStatus()).toBe(404);
  });

  it('maps a malformed preferences body to 502', async () => {
    const scripted = new ScriptedDownstream([ok({ unexpected: 'shape' })]);
    await expect(
      buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a prep-snapshot 401 (shared-secret misconfig) to 502', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      { kind: 'client_error', status: 401, body: {}, setCookies: [] },
    ]);
    await expect(
      buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a search timeout to 504', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok(VALID_PREP_SNAPSHOT),
      { kind: 'timeout' },
    ]);
    await expect(
      buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(GatewayTimeoutException);
  });

  it('maps a search network error to 502', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok(VALID_PREP_SNAPSHOT),
      { kind: 'network_error', detail: 'ECONNREFUSED' },
    ]);
    await expect(
      buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('maps a search not_configured to 503', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok(VALID_PREP_SNAPSHOT),
      { kind: 'not_configured', service: 'search' } as DownstreamResult,
    ]);
    await expect(
      buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a malformed recommendations body to 502', async () => {
    const scripted = new ScriptedDownstream([
      ok(VALID_PREFERENCES),
      ok(VALID_PREP_SNAPSHOT),
      ok({ recommendations: 'not-an-array', liveMode: false }),
    ]);
    await expect(
      buildController(scripted).getRecommendedProviders('snr_abc', REQUEST_WITH_CTX),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });
});
