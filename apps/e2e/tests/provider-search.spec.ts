import { expect, test } from '@playwright/test';

import { registerVerifiedUser } from '../src/auth-flows';
import { gateway } from '../src/gateway-client';
import { indexProvider, providerDocument, searchProviders } from '../src/search-flows';

/**
 * Provider discovery through the gateway (TS-505c).
 *
 * **What only this level can assert.** service-search's own suite proves the
 * backend ranks and filters correctly against documents it inserted itself.
 * What it cannot prove is that a document written through the *indexer's*
 * route is the same document a *family's* search reads back — two surfaces, two
 * schemas, one gateway re-validating in between, each of which has been
 * changed independently. A field the index accepts and the search response
 * schema rejects is a 502 no unit suite sees.
 *
 * **The backend is the in-memory one** (PDD §14.1 Phase 1): `.env.example`
 * declares no `ELASTICSEARCH_NODE_URL`, so `liveMode` is false throughout, and
 * the suite asserts that rather than ignoring it — a run that quietly acquired
 * a live backend would be testing something else.
 */
test.describe('provider discovery', () => {
  test('a document written through the internal index route is discoverable by a family', async () => {
    const family = await registerVerifiedUser('search-family');
    const document = providerDocument({ specialties: ['meal-prep', 'diabetic-friendly'] });

    const indexed = await indexProvider(document);
    expect(indexed.providerId).toBe(document.providerId);
    expect(indexed.liveMode).toBe(false);

    const results = await searchProviders(family.accessToken, {
      query: document.displayName,
      limit: 10,
    });

    expect(results.liveMode).toBe(false);
    // Non-empty and non-null by contract; asserted because the correlation
    // token is what joins a later booking back to this search (TS-217-prep-4c)
    // and it is minted unconditionally, so an absent one is a real regression.
    expect(results.searchId).toBeTruthy();

    const hit = results.hits.find((entry) => entry.document.providerId === document.providerId);
    expect(hit, `indexed provider ${document.providerId} was not in the result set`).toBeDefined();
    // Round-trip equality across the two contracts, not just presence: the
    // point of the assertion is that nothing was lost between the index write
    // and the search read.
    expect(hit?.document).toEqual(document);
  });

  test('the status filter defaults to active, so a suspended provider is not offered', async () => {
    const family = await registerVerifiedUser('search-status');
    const suspended = providerDocument({ status: 'suspended' });
    await indexProvider(suspended);

    const defaulted = await searchProviders(family.accessToken, {
      query: suspended.displayName,
      limit: 10,
    });
    expect(
      defaulted.hits.map((entry) => entry.document.providerId),
      'a suspended provider was offered to a family with no explicit status filter',
    ).not.toContain(suspended.providerId);

    // The document IS indexed — the default is a filter, not a failed write.
    // Without this half, a broken index write would produce the same green.
    const widened = await searchProviders(family.accessToken, {
      query: suspended.displayName,
      filters: { statuses: ['suspended'] },
      limit: 10,
    });
    expect(widened.hits.map((entry) => entry.document.providerId)).toContain(suspended.providerId);
  });

  test('provider search requires an authenticated caller', async () => {
    const response = await gateway('/api/v1/search/providers', {
      method: 'POST',
      body: { limit: 10 },
    });
    expect(response.status).toBe(401);
  });

  test('the gateway rejects a distance sort with no geo, before it reaches the backend', async () => {
    const family = await registerVerifiedUser('search-sort');

    const response = await gateway('/api/v1/search/providers', {
      method: 'POST',
      accessToken: family.accessToken,
      body: { sort: 'distance', limit: 10 },
    });

    // 400 at the edge, not a 422 from the backend: the contract refines this
    // pair, and the gateway parses the request with the same schema. A 422
    // here would mean the edge is forwarding a request it can already tell is
    // invalid, which is the failure mode the refinement exists to prevent.
    expect(response.status).toBe(400);
  });
});
