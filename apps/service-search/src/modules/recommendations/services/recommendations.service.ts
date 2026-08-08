import { Inject, Injectable } from '@nestjs/common';
import type {
  RecommendProvidersRequest,
  RecommendProvidersResponse,
} from '@taste-and-see/contracts';

import { SEARCH_BACKEND_TOKEN, type SearchBackend } from '../../providers/services/search-backend';

/**
 * Orchestrates the match-recommendation surface (TS-213). Thin wrapper
 * around the configured `SearchBackend` — translates the internal
 * `RecommendProvidersRequest` into a backend call and shapes the result
 * onto the wire contract (mirroring `ProviderSearchService.search`).
 *
 * The scoring engine lives in the backend so a TS-111-followup-1 swap to
 * live `@elastic/elasticsearch` is a single-file change. The service
 * itself never touches senior data — it receives the de-identified
 * signal profile already assembled by the api-gateway BFF.
 */
@Injectable()
export class RecommendationsService {
  constructor(@Inject(SEARCH_BACKEND_TOKEN) private readonly backend: SearchBackend) {}

  async recommend(request: RecommendProvidersRequest): Promise<RecommendProvidersResponse> {
    const outcome = await this.backend.recommendProviders({ request });
    return {
      recommendations: outcome.recommendations.map((recommendation) => ({
        document: recommendation.document,
        score: recommendation.score,
        signals: recommendation.signals.map((signal) => ({
          kind: signal.kind,
          matchedValues: [...signal.matchedValues],
          contribution: signal.contribution,
        })),
      })),
      liveMode: this.backend.isLiveMode(),
    };
  }
}
