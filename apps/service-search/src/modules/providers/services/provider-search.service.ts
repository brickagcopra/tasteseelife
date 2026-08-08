import { Inject, Injectable } from '@nestjs/common';
import type {
  AdTargetingAudience,
  DeleteProviderDocumentResponse,
  ProviderDiscoveryDocument,
  ProviderDiscoveryHit,
  SearchProvidersRequest,
  SearchProvidersResponse,
  UpsertProviderDocumentResponse,
} from '@taste-and-see/contracts';

import { SEARCH_BACKEND_TOKEN, type SearchBackend } from './search-backend';
import { SearchMetrics } from './search-metrics';
import { SponsoredListingsClient } from './sponsored-listings.client';
import { applySponsoredSlots } from './sponsored-slots';

/**
 * Orchestrates the provider-discovery surface (TS-111). Thin wrapper
 * around the configured `SearchBackend`:
 *
 *   - Translates the public `SearchProvidersRequest` into a backend
 *     call and shapes the response onto the wire contract.
 *   - Enforces `:providerId` path-vs-body consistency on upsert (the
 *     defence-in-depth gate documented on `UpsertProviderDocumentRequestSchema`).
 *
 * The actual filtering / ranking / pagination logic lives in the
 * backend so a TS-111-followup-1 swap to live `@elastic/elasticsearch`
 * is a single-file change.
 */
@Injectable()
export class ProviderSearchService {
  constructor(
    @Inject(SEARCH_BACKEND_TOKEN) private readonly backend: SearchBackend,
    private readonly sponsored: SponsoredListingsClient,
    private readonly metrics: SearchMetrics,
  ) {}

  /**
   * Runs the discovery query and shapes the backend outcome onto the wire
   * contract — minus `searchId`. The correlation id (TS-217-prep-4a) is
   * minted by the controller (which owns the `search.performed` emit), so
   * the service stays purely about search and the `Omit` makes the
   * controller's obligation to attach it a compile-time guarantee.
   *
   * **TS-218b — sponsored slots.** When an `audience` is supplied (the
   * controller derives it from the access-token context), the FIRST results
   * page reserves up to N top slots for sponsored providers: the ranked
   * organic candidate ids are resolved against service-ads (TS-218a, via
   * `SponsoredListingsClient`) and the winners are promoted to the top with
   * their campaign + creative stamped on the hit. The resolve is best-effort
   * — any failure leaves the organic results untouched. Paged scrolls
   * (`cursor` present) never re-seat sponsored slots; they live at the top
   * of page one only.
   */
  async search(
    request: SearchProvidersRequest,
    options?: { readonly audience: AdTargetingAudience },
  ): Promise<Omit<SearchProvidersResponse, 'searchId'>> {
    // TS-111-followup-4 — monotonic timing for the query-latency histogram,
    // spanning the backend query + the best-effort sponsored overlay (the
    // overlay is part of the family-portal's perceived search latency).
    const startNs = process.hrtime.bigint();
    const outcome = await this.backend.searchProviders({ request });
    const baseHits: ProviderDiscoveryHit[] = outcome.hits.map((hit) => ({
      document: hit.document,
      score: hit.score,
      distanceKm: hit.distanceKm,
      featured: hit.featured,
      sponsored: hit.sponsored,
    }));
    const hits = await this.overlaySponsoredSlots(request, baseHits, options?.audience);
    const liveMode = this.backend.isLiveMode();

    // TS-111-followup-4 — record outcome + latency. `outcome=empty` keys on
    // the resolved page being empty (no rows to show the family); the
    // dropped sub-second/ns precision is below the histogram's bucket
    // resolution so `Number(...)` is safe.
    const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    this.metrics.recordQuery({
      outcome: hits.length > 0 ? 'ok' : 'empty',
      sort: request.sort,
      liveMode,
      seconds,
    });

    return {
      hits,
      facets: outcome.facets,
      totalEstimate: outcome.totalEstimate,
      nextCursor: outcome.nextCursor,
      liveMode,
    };
  }

  /**
   * Resolve + seat the sponsored top slots (TS-218b). Skipped — returns the
   * organic hits unchanged — when there is no audience (e.g. an internal /
   * non-family caller), on a paged request (sponsored slots are page-one
   * only), or with an empty page. The resolve itself fails open.
   */
  private async overlaySponsoredSlots(
    request: SearchProvidersRequest,
    hits: ProviderDiscoveryHit[],
    audience: AdTargetingAudience | undefined,
  ): Promise<ProviderDiscoveryHit[]> {
    if (audience === undefined || request.cursor !== undefined || hits.length === 0) {
      return hits;
    }
    const listings = await this.sponsored.resolve({
      audience,
      candidateProviderIds: hits.map((hit) => hit.document.providerId),
    });
    return applySponsoredSlots(hits, listings);
  }

  async upsertProvider(input: {
    providerIdPath: string;
    document: ProviderDiscoveryDocument;
  }): Promise<UpsertProviderResult> {
    if (input.providerIdPath !== input.document.providerId) {
      this.metrics.recordUpsert('provider_id_mismatch');
      return {
        kind: 'failure',
        failure: 'provider_id_mismatch',
        detail: 'path :providerId must match document.providerId',
      };
    }

    const result = await this.backend.upsertProvider({ document: input.document });
    this.metrics.recordUpsert(result.outcome);
    return {
      kind: 'success',
      response: {
        outcome: result.outcome,
        providerId: result.providerId,
        indexedAt: result.indexedAt,
        liveMode: this.backend.isLiveMode(),
      },
    };
  }

  async deleteProvider(input: { providerId: string }): Promise<DeleteProviderDocumentResponse> {
    const result = await this.backend.deleteProvider({ providerId: input.providerId });
    this.metrics.recordDelete(result.outcome);
    return {
      outcome: result.outcome,
      providerId: result.providerId,
      deletedAt: result.deletedAt,
      liveMode: this.backend.isLiveMode(),
    };
  }
}

export type UpsertProviderResult =
  | { readonly kind: 'success'; readonly response: UpsertProviderDocumentResponse }
  | {
      readonly kind: 'failure';
      readonly failure: 'provider_id_mismatch';
      readonly detail: string;
    };
