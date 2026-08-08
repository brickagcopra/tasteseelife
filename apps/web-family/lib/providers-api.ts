import {
  SearchProvidersResponseSchema,
  type ProviderDiscoveryHit,
  type ProviderDiscoveryFacets,
  type ProviderDiscoveryTier,
  type SearchProvidersRequest,
  type SearchProvidersResponse,
} from '@taste-and-see/contracts';

import { callGateway } from './api';

/**
 * Provider discovery client for the family portal (TS-125).
 *
 * Calls the gateway's `POST /api/v1/search/providers` proxy and
 * validates the response at the portal boundary. Returns a typed
 * discriminated union so server components can branch cleanly on
 * `unauthorized` (redirect to login) / `failure` (render an empty
 * state with explainer) / `ok` (render the result grid).
 */

export interface ProvidersLoadOk {
  readonly kind: 'ok';
  readonly hits: readonly ProviderDiscoveryHit[];
  readonly facets: ProviderDiscoveryFacets;
  readonly totalEstimate: number;
  readonly nextCursor: string | null;
  readonly liveMode: boolean;
  /**
   * The search-correlation token (TS-217-prep-4a). Echoed on the result-click
   * beacon (`search.result_clicked`, TS-217-prep-4b) so the search-relevance
   * dashboard can join clicks back to the originating query.
   */
  readonly searchId: string;
}
export interface ProvidersLoadUnauthorized {
  readonly kind: 'unauthorized';
}
export interface ProvidersLoadFailure {
  readonly kind: 'failure';
  readonly detail: string;
}
export type ProvidersLoadResult =
  | ProvidersLoadOk
  | ProvidersLoadUnauthorized
  | ProvidersLoadFailure;

export async function searchProviders(
  request: SearchProvidersRequest | Record<string, never>,
): Promise<ProvidersLoadResult> {
  const result = await callGateway<unknown>('/api/v1/search/providers', {
    method: 'POST',
    body: request,
  });
  if (result.kind === 'unauthorized') {
    return { kind: 'unauthorized' };
  }
  if (result.kind !== 'ok') {
    return { kind: 'failure', detail: `gateway responded with ${result.kind}` };
  }
  const parsed: SearchProvidersResponse | undefined = parseResponse(result.body);
  if (parsed === undefined) {
    return { kind: 'failure', detail: 'gateway returned a malformed search response' };
  }
  return {
    kind: 'ok',
    hits: parsed.hits,
    facets: parsed.facets,
    totalEstimate: parsed.totalEstimate,
    nextCursor: parsed.nextCursor,
    liveMode: parsed.liveMode,
    searchId: parsed.searchId,
  };
}

function parseResponse(body: unknown): SearchProvidersResponse | undefined {
  const result = SearchProvidersResponseSchema.safeParse(body);
  return result.success ? result.data : undefined;
}

const TIER_LABELS: Record<ProviderDiscoveryTier, string> = {
  basic: 'Basic',
  certified: 'Certified Culinary Companion',
  elite: 'Elite Concierge',
};

export function formatTier(tier: ProviderDiscoveryTier): string {
  return TIER_LABELS[tier];
}
