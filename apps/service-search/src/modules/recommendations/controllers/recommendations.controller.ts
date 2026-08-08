import { Body, Controller, HttpCode, HttpStatus, Inject, Post, UseGuards } from '@nestjs/common';
import {
  RecommendProvidersRequestSchema,
  type RecommendProvidersRequest,
  type RecommendProvidersResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { InternalSharedSecretGuard } from '../../../common/guards/internal-shared-secret.guard';
import { RecommendationsService } from '../services/recommendations.service';

/**
 * Internal match-recommendation surface (TS-213).
 *
 *   POST /api/v1/internal/search/recommendations
 *     Scores the active provider set against a de-identified senior
 *     signal profile and returns the top-N with explainability metadata.
 *
 * Pinned by `InternalSharedSecretGuard` — shares the `SEARCH_INDEX_*`
 * env pair the TS-053 indexer + TS-211 ranking-config + TS-207
 * featured-placement internal surfaces use. The api-gateway BFF
 * (`SeniorRecommendationsAggregatorController`) does actor↔senior authz,
 * assembles the signal profile from the senior's intake + preference
 * cues, and forwards here so the secret never reaches the browser and
 * service-search never reads senior data (CLAUDE.md §2.3, §12).
 *
 * **POST returns 200, not 201** — this is a query (no resource created),
 * mirroring the public `POST /api/v1/search/providers` shape.
 *
 * **Tenant-scoping.** Same shape as `FeaturedPlacementsController` /
 * `RankingConfigController` — the `InternalSharedSecretGuard` does NOT
 * seed a `request.requestContext`, and the backend resolves tier weights
 * from the `SearchRankingConfig` Postgres row (an `unscopedModel`), so
 * the handler wraps in `runWithoutTenantContext(...)` to satisfy the
 * `enforce` gate.
 */
@Controller('api/v1/internal/search/recommendations')
@UseGuards(InternalSharedSecretGuard)
export class RecommendationsController {
  constructor(
    private readonly service: RecommendationsService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async recommend(
    @Body(new ZodValidationPipe(RecommendProvidersRequestSchema))
    body: RecommendProvidersRequest,
  ): Promise<RecommendProvidersResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-search-recommendations', async () =>
      this.service.recommend(body),
    );
  }
}
