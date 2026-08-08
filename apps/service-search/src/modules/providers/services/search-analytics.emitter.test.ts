import type { SearchProvidersRequest, SearchProvidersResponse } from '@taste-and-see/contracts';
import { SEARCH_PERFORMED, SearchPerformedSchema } from '@taste-and-see/contracts';
import type { AppendArgs, AppendResult, OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { buildSearchPerformedPayload, SearchAnalyticsEmitter } from './search-analytics.emitter';

const ISO_EVENT = '2026-06-08T12:00:00.000Z';

function buildRequest(overrides: Partial<SearchProvidersRequest> = {}): SearchProvidersRequest {
  return {
    sort: 'relevance',
    limit: 20,
    ...overrides,
  };
}

function buildResponse(overrides: Partial<SearchProvidersResponse> = {}): SearchProvidersResponse {
  return {
    hits: [],
    facets: {
      tiers: [],
      languages: [],
      specialties: [],
      cuisines: [],
      certifications: [],
    },
    totalEstimate: 0,
    nextCursor: null,
    liveMode: false,
    searchId: 'srch_fixture',
    ...overrides,
  };
}

function hit(providerId: string): SearchProvidersResponse['hits'][number] {
  return {
    document: {
      providerId,
      userId: `user_${providerId}`,
      displayName: 'Chef',
      headline: null,
      bio: null,
      tier: 'certified',
      status: 'active',
      languages: ['en'],
      specialties: [],
      cuisines: [],
      dietaryExpertise: [],
      certifications: [],
      centroid: null,
      ratingAverage: null,
      ratingCount: 0,
      completedBookingCount: 0,
      profilePhotoKey: null,
      videoIntroKey: null,
      timeZone: 'America/New_York',
      availabilitySummary: null,
      sourceUpdatedAt: ISO_EVENT,
    },
    score: 1,
    distanceKm: null,
    featured: false,
    sponsored: null,
  };
}

describe('buildSearchPerformedPayload', () => {
  it('projects a text query with filters + tiers + geo onto the event', () => {
    const payload = buildSearchPerformedPayload({
      eventId: 'evt_1',
      occurredAt: ISO_EVENT,
      actorUserId: 'user_abc',
      request: buildRequest({
        query: 'kosher italian',
        geo: { center: { latitude: 40.7, longitude: -73.9 }, radiusKm: 25 },
        filters: { tiers: ['elite'], languages: ['it'], minRating: 4 },
        sort: 'distance',
      }),
      response: buildResponse({ hits: [hit('prov_1'), hit('prov_2')], totalEstimate: 7 }),
    });

    expect(payload).toStrictEqual({
      eventId: 'evt_1',
      occurredAt: ISO_EVENT,
      actorUserId: 'user_abc',
      queryText: 'kosher italian',
      sort: 'distance',
      hasGeo: true,
      // Canonical schema-enum order, NOT request insertion order.
      appliedFilters: ['tiers', 'languages', 'minRating'],
      filterTiers: ['elite'],
      resultCount: 2,
      totalEstimate: 7,
      zeroResults: false,
      page: 'first',
      liveMode: false,
    });
    // The projection always satisfies the contract's cross-field invariants.
    expect(SearchPerformedSchema.safeParse(payload).success).toBe(true);
  });

  it('maps an empty discovery query to null text + empty facets + first page', () => {
    const payload = buildSearchPerformedPayload({
      eventId: 'evt_2',
      occurredAt: ISO_EVENT,
      actorUserId: 'user_abc',
      request: buildRequest(),
      response: buildResponse({ totalEstimate: 0 }),
    });

    expect(payload.queryText).toBeNull();
    expect(payload.appliedFilters).toEqual([]);
    expect(payload.filterTiers).toEqual([]);
    expect(payload.hasGeo).toBe(false);
    expect(payload.zeroResults).toBe(true);
    expect(payload.page).toBe('first');
    expect(SearchPerformedSchema.safeParse(payload).success).toBe(true);
  });

  it('marks a cursor-bearing request as a paged query', () => {
    const payload = buildSearchPerformedPayload({
      eventId: 'evt_3',
      occurredAt: ISO_EVENT,
      actorUserId: 'user_abc',
      request: buildRequest({ cursor: 'offset:20' }),
      response: buildResponse({ hits: [hit('prov_1')], totalEstimate: 30 }),
    });
    expect(payload.page).toBe('paged');
    expect(payload.resultCount).toBe(1);
    expect(payload.totalEstimate).toBe(30);
    expect(payload.zeroResults).toBe(false);
  });

  it('carries liveMode through from the backend response', () => {
    const payload = buildSearchPerformedPayload({
      eventId: 'evt_4',
      occurredAt: ISO_EVENT,
      actorUserId: 'user_abc',
      request: buildRequest({ query: 'x' }),
      response: buildResponse({ hits: [hit('p')], totalEstimate: 1, liveMode: true }),
    });
    expect(payload.liveMode).toBe(true);
  });
});

/**
 * Captures every `append` call so the emitter's behaviour can be
 * asserted without a real Postgres / outbox SDK.
 */
class FakeOutbox {
  readonly calls: Array<AppendArgs<typeof SEARCH_PERFORMED>> = [];
  result: AppendResult = {
    kind: 'appended',
    eventId: 'unused',
    eventName: SEARCH_PERFORMED,
    occurredAt: new Date(),
  };
  throwOnAppend: Error | null = null;

  append(_tx: unknown, args: AppendArgs<typeof SEARCH_PERFORMED>): Promise<AppendResult> {
    if (this.throwOnAppend !== null) {
      return Promise.reject(this.throwOnAppend);
    }
    this.calls.push(args);
    return Promise.resolve(this.result);
  }
}

function makeEmitter(outbox: FakeOutbox): SearchAnalyticsEmitter {
  return new SearchAnalyticsEmitter(
    outbox as unknown as OutboxService,
    {} as unknown as PrismaService,
  );
}

describe('SearchAnalyticsEmitter.emitSearchPerformed', () => {
  it('appends search.performed with a self-consistent envelope', async () => {
    const outbox = new FakeOutbox();
    const emitter = makeEmitter(outbox);

    await emitter.emitSearchPerformed({
      searchId: 'srch_pierogi_1',
      actorUserId: 'user_abc',
      request: buildRequest({ query: 'pierogi', filters: { tiers: ['basic'] } }),
      response: buildResponse({ hits: [hit('p1')], totalEstimate: 4 }),
    });

    expect(outbox.calls).toHaveLength(1);
    const call = outbox.calls[0];
    expect(call?.eventName).toBe(SEARCH_PERFORMED);
    // Column event_id matches the payload envelope eventId (so the
    // outbox row and the consumer-visible payload agree on the id) AND
    // equals the caller-minted searchId (the token returned to the
    // client) — TS-217-prep-4a.
    expect(call?.eventId).toBe(call?.payload.eventId);
    expect(call?.eventId).toBe('srch_pierogi_1');
    expect(call?.payload.eventId).toBe('srch_pierogi_1');
    expect(call?.occurredAt?.toISOString()).toBe(call?.payload.occurredAt);
    expect(call?.payload.actorUserId).toBe('user_abc');
    expect(call?.payload.queryText).toBe('pierogi');
    expect(call?.payload.filterTiers).toEqual(['basic']);
    expect(call?.payload.resultCount).toBe(1);
    expect(call?.payload.totalEstimate).toBe(4);
    // The appended payload is a valid registry event.
    expect(SearchPerformedSchema.safeParse(call?.payload).success).toBe(true);
  });

  it('swallows a thrown append (best-effort — never breaks a search)', async () => {
    const outbox = new FakeOutbox();
    outbox.throwOnAppend = new Error('postgres unreachable');
    const emitter = makeEmitter(outbox);

    await expect(
      emitter.emitSearchPerformed({
        searchId: 'srch_throw',
        actorUserId: 'user_abc',
        request: buildRequest({ query: 'x' }),
        response: buildResponse({ hits: [hit('p')], totalEstimate: 1 }),
      }),
    ).resolves.toBeUndefined();
  });

  it('swallows a validation_failed result without throwing', async () => {
    const outbox = new FakeOutbox();
    outbox.result = {
      kind: 'validation_failed',
      eventName: SEARCH_PERFORMED,
      issues: [{ path: ['queryText'], message: 'too long' }],
    };
    const emitter = makeEmitter(outbox);

    await expect(
      emitter.emitSearchPerformed({
        searchId: 'srch_validation',
        actorUserId: 'user_abc',
        request: buildRequest(),
        response: buildResponse({ totalEstimate: 0 }),
      }),
    ).resolves.toBeUndefined();
  });
});
