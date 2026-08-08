import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  FEATURED_PLACEMENT_ID_MAX_LENGTH,
  ListFeaturedPlacementsQuerySchema,
  ScheduleFeaturedPlacementRequestSchema,
  type DeleteFeaturedPlacementResponse,
  type FeaturedPlacementsListResponse,
  type ListFeaturedPlacementsQuery,
  type ScheduleFeaturedPlacementRequest,
  type ScheduleFeaturedPlacementResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { z } from 'zod';

import { InternalSharedSecretGuard } from '../../../common/guards/internal-shared-secret.guard';
import { FeaturedPlacementsService } from '../services/featured-placements.service';

// Path-param validator — bounds the id so a malformed value can't dodge the
// index lookup. A single primitive, defined inline rather than exported from
// the contract package.
const PlacementIdSchema = z.string().min(1).max(FEATURED_PLACEMENT_ID_MAX_LENGTH);

/**
 * Internal featured-placement admin surface (TS-207).
 *
 *   `GET    /api/v1/internal/search/featured-placements`              — list
 *   `POST   /api/v1/internal/search/featured-placements`             — schedule
 *   `DELETE /api/v1/internal/search/featured-placements/:placementId` — cancel
 *
 * All three routes are pinned by `InternalSharedSecretGuard` — they share
 * the `SEARCH_INDEX_HEADER_NAME` / `SEARCH_INDEX_API_KEY` env pair the
 * TS-053 indexer worker and the TS-211 ranking-config endpoints use. The
 * api-gateway BFF (`AdminFeaturedPlacementsProxyController`) forwards
 * super_admin-gated writes from web-admin through this surface so the shared
 * secret never reaches the browser.
 *
 * **Tenant-scoping.** Same shape as `RankingConfigController` — the
 * `InternalSharedSecretGuard` does NOT seed a `request.requestContext`, so
 * each handler wraps in `runWithoutTenantContext(...)`. `FeaturedPlacement`
 * is listed as an `unscopedModel` (platform-wide ops config), so the model
 * access is legal even under the `enforce` posture, but the exempt frame is
 * still the disciplined shape.
 */
@Controller('api/v1/internal/search/featured-placements')
@UseGuards(InternalSharedSecretGuard)
export class FeaturedPlacementsController {
  constructor(
    private readonly service: FeaturedPlacementsService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Query(new ZodValidationPipe(ListFeaturedPlacementsQuerySchema))
    query: ListFeaturedPlacementsQuery,
  ): Promise<FeaturedPlacementsListResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-featured-placements-list',
      async () => this.service.list(query),
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async schedule(
    @Body(new ZodValidationPipe(ScheduleFeaturedPlacementRequestSchema))
    body: ScheduleFeaturedPlacementRequest,
  ): Promise<ScheduleFeaturedPlacementResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-featured-placements-schedule',
      async () => this.service.schedule(body),
    );
  }

  @Delete(':placementId')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('placementId', new ZodValidationPipe(PlacementIdSchema))
    placementId: string,
  ): Promise<DeleteFeaturedPlacementResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-featured-placements-delete',
      async () => {
        const result = await this.service.delete(placementId);
        return { outcome: result.outcome, placementId };
      },
    );
  }
}
