import { UnauthorizedException } from '@nestjs/common';
import type { SearchProvidersRequest, SearchProvidersResponse } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it } from 'vitest';

import type { ProviderSearchService } from '../services/provider-search.service';
import type { SearchAnalyticsEmitter } from '../services/search-analytics.emitter';
import { ProviderSearchController } from './provider-search.controller';

// The service shapes everything BUT the searchId (TS-217-prep-4a) — the
// controller mints the correlation token and attaches it.
const SERVICE_RESULT: Omit<SearchProvidersResponse, 'searchId'> = {
  hits: [],
  facets: { tiers: [], languages: [], specialties: [], cuisines: [], certifications: [] },
  totalEstimate: 0,
  nextCursor: null,
  liveMode: false,
};

class FakeService {
  lastBody: SearchProvidersRequest | null = null;
  search(body: SearchProvidersRequest): Promise<Omit<SearchProvidersResponse, 'searchId'>> {
    this.lastBody = body;
    return Promise.resolve(SERVICE_RESULT);
  }
}

class FakeEmitter {
  calls: Array<{
    searchId: string;
    actorUserId: string;
    request: SearchProvidersRequest;
    response: SearchProvidersResponse;
  }> = [];
  emitSearchPerformed(input: {
    searchId: string;
    actorUserId: string;
    request: SearchProvidersRequest;
    response: SearchProvidersResponse;
  }): Promise<void> {
    this.calls.push(input);
    return Promise.resolve();
  }
}

function makeController(): {
  controller: ProviderSearchController;
  service: FakeService;
  emitter: FakeEmitter;
} {
  const service = new FakeService();
  const emitter = new FakeEmitter();
  const controller = new ProviderSearchController(
    service as unknown as ProviderSearchService,
    emitter as unknown as SearchAnalyticsEmitter,
  );
  return { controller, service, emitter };
}

function reqWith(userId: string | undefined): RequestWithContext {
  return {
    requestContext: userId === undefined ? undefined : { userId },
  } as unknown as RequestWithContext;
}

describe('ProviderSearchController.search', () => {
  it('returns the search result with a minted searchId and emits search.performed with the actor', async () => {
    const { controller, service, emitter } = makeController();
    const body: SearchProvidersRequest = { query: 'sushi', sort: 'relevance', limit: 20 };

    const result = await controller.search(reqWith('user_abc'), body);

    // The controller mints a non-empty correlation token and attaches it
    // to the service result (TS-217-prep-4a).
    expect(typeof result.searchId).toBe('string');
    expect(result.searchId.length).toBeGreaterThan(0);
    expect(result).toEqual({ ...SERVICE_RESULT, searchId: result.searchId });
    expect(service.lastBody).toBe(body);

    expect(emitter.calls).toHaveLength(1);
    // The emit carries the SAME token returned to the client, so the
    // event's envelope id matches the client-visible searchId.
    expect(emitter.calls[0]).toEqual({
      searchId: result.searchId,
      actorUserId: 'user_abc',
      request: body,
      response: result,
    });
  });

  it('rejects a request with no authenticated context (defensive 401)', async () => {
    const { controller, service, emitter } = makeController();

    await expect(
      controller.search(reqWith(undefined), { sort: 'relevance', limit: 20 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Neither the search nor the analytics emit ran.
    expect(service.lastBody).toBeNull();
    expect(emitter.calls).toHaveLength(0);
  });
});
