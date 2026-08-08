import { randomUUID } from 'node:crypto';

import {
  SearchProvidersResponseSchema,
  UpsertProviderDocumentResponseSchema,
  type ProviderDiscoveryDocument,
  type SearchProvidersRequest,
  type SearchProvidersResponse,
  type UpsertProviderDocumentResponse,
} from '@taste-and-see/contracts';

import { gateway } from './gateway-client';
import { expectInternalStatus, internal } from './internal-client';

/**
 * Provider-discovery flows (TS-505c).
 *
 * Two halves that meet in the middle: the *write* half puts a document into
 * the index through the cluster-internal route the search-indexer owns, and
 * the *read* half queries it through the gateway as a family would. Only the
 * read half is a client surface, which is why only it goes through
 * `gateway()` — see `internal-client.ts` for why the write half may not.
 *
 * **Every provider minted here is unique per call** (CLAUDE.md §9.3). The
 * in-memory backend is process-global for the life of the fleet, so a fixed
 * provider id would leave one spec's document visible to the next and turn a
 * "the index is empty" assertion into a coin flip.
 */

/** A provider document, valid by construction, with per-call overrides. */
export function providerDocument(
  overrides: Partial<ProviderDiscoveryDocument> = {},
): ProviderDiscoveryDocument {
  const providerId = `e2e-provider-${randomUUID()}`;
  return {
    providerId,
    userId: `e2e-provider-user-${randomUUID()}`,
    // The display name carries the provider id so a full-text query can
    // target exactly one document without depending on the ranking weights.
    // Asserting "my provider came back" must not become "my provider ranked
    // first", which is a different property with a different owner
    // (`search_ranking_config`, TS-211).
    displayName: `E2E Kitchen ${providerId}`,
    headline: 'Home-cooked meals and good company',
    bio: null,
    tier: 'certified',
    status: 'active',
    languages: ['en'],
    specialties: ['meal-prep'],
    cuisines: ['italian'],
    dietaryExpertise: ['low-sodium'],
    certifications: ['servsafe'],
    centroid: null,
    ratingAverage: null,
    ratingCount: 0,
    completedBookingCount: 0,
    profilePhotoKey: null,
    videoIntroKey: null,
    timeZone: 'America/New_York',
    availabilitySummary: null,
    sourceUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * `PUT /api/v1/internal/search/providers/:providerId` — index one document.
 *
 * Asserts its own outcome: an `unchanged` where the spec expected `created`
 * means a previous run's document is still resident, and every later
 * assertion in that spec would then be about the wrong document.
 */
export async function indexProvider(
  document: ProviderDiscoveryDocument,
): Promise<UpsertProviderDocumentResponse> {
  const response = await internal(
    'service-search',
    `/api/v1/internal/search/providers/${encodeURIComponent(document.providerId)}`,
    { method: 'PUT', body: { document }, secretEnvKey: 'SEARCH_INDEX_API_KEY' },
  );
  expectInternalStatus(response, 200, 'search provider index upsert');

  const parsed = UpsertProviderDocumentResponseSchema.parse(response.body);
  if (parsed.outcome !== 'created') {
    throw new Error(
      `indexing ${document.providerId} reported '${parsed.outcome}', expected 'created' — ` +
        `the index already held this provider.`,
    );
  }
  return parsed;
}

/** `POST /api/v1/search/providers` through the gateway, as a family would. */
export async function searchProviders(
  accessToken: string,
  request: SearchProvidersRequest | Record<string, unknown> = {},
): Promise<SearchProvidersResponse> {
  const response = await gateway('/api/v1/search/providers', {
    method: 'POST',
    accessToken,
    body: request,
  });
  if (response.status !== 200) {
    throw new Error(
      `provider search returned ${String(response.status)}: ${response.text.slice(0, 800)}`,
    );
  }
  return SearchProvidersResponseSchema.parse(response.body);
}
