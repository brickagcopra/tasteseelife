import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Put,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  SEARCH_RANKING_REGION_CODE_GLOBAL,
  SEARCH_RANKING_REGION_CODE_MAX_LENGTH,
  SearchRankingConfigRegionCodeSchema,
  UpsertSearchRankingConfigRequestSchema,
  type DeleteSearchRankingConfigResponse,
  type GetSearchRankingConfigResponse,
  type ListSearchRankingConfigResponse,
  type UpsertSearchRankingConfigRequest,
  type UpsertSearchRankingConfigResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { InternalSharedSecretGuard } from '../../../common/guards/internal-shared-secret.guard';
import { RankingConfigService } from '../services/ranking-config.service';

/**
 * Internal search ranking-config admin surface (TS-211).
 *
 *   `GET    /api/v1/internal/search/ranking-config`               — list
 *   `GET    /api/v1/internal/search/ranking-config/:regionCode`   — get one
 *   `PUT    /api/v1/internal/search/ranking-config/:regionCode`   — upsert
 *   `DELETE /api/v1/internal/search/ranking-config/:regionCode`   — delete
 *
 * All four routes are pinned by `InternalSharedSecretGuard` — they share
 * the `SEARCH_INDEX_HEADER_NAME` / `SEARCH_INDEX_API_KEY` env pair the
 * TS-053 indexer worker already uses. The api-gateway BFF (TS-211-followup-1)
 * forwards super_admin-gated writes from web-admin (TS-211-followup-2)
 * through this surface so the shared secret never reaches the browser.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout-svc-search).**
 * The `InternalSharedSecretGuard` does NOT seed a `request.requestContext`
 * — there is no authenticated user behind these calls. Service-search
 * has Prisma now (TS-211 added the first model), so every handler body
 * wraps in `runWithoutTenantContext(..., 'internal-search-ranking-*', ...)`
 * to satisfy the gate. `SearchRankingConfig` is listed as `unscopedModels`
 * (it's platform-wide ops config), so even with an `enforce` posture the
 * model access from this surface is legal — but the exempt frame on the
 * outer wrap is still the right disciplined shape and lets the canonical
 * eleven-service rollout pattern stay consistent.
 *
 * **`global` row protection.** Deleting `global` is rejected at the
 * service layer (`outcome: 'global_protected'`) — this controller maps
 * the outcome to a 422 with a guidance detail line.
 */
@Controller('api/v1/internal/search/ranking-config')
@UseGuards(InternalSharedSecretGuard)
export class RankingConfigController {
  constructor(
    private readonly service: RankingConfigService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(): Promise<ListSearchRankingConfigResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-ranking-config-list',
      async () => this.service.list(),
    );
  }

  @Get(':regionCode')
  @HttpCode(HttpStatus.OK)
  async getByRegion(
    @Param('regionCode', new ZodValidationPipe(SearchRankingConfigRegionCodeSchema))
    regionCode: string,
  ): Promise<GetSearchRankingConfigResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-ranking-config-get',
      async () => {
        const config = await this.service.get(regionCode);
        if (config === null) {
          return { kind: 'not_found', regionCode } satisfies GetSearchRankingConfigResponse;
        }
        return { kind: 'found', config } satisfies GetSearchRankingConfigResponse;
      },
    );
  }

  @Put(':regionCode')
  @HttpCode(HttpStatus.OK)
  async upsertByRegion(
    @Param('regionCode', new ZodValidationPipe(SearchRankingConfigRegionCodeSchema))
    regionCode: string,
    @Body(new ZodValidationPipe(UpsertSearchRankingConfigRequestSchema))
    body: UpsertSearchRankingConfigRequest,
  ): Promise<UpsertSearchRankingConfigResponse> {
    if (regionCode.length > SEARCH_RANKING_REGION_CODE_MAX_LENGTH) {
      // The Zod path-param pipe should have rejected this already; the
      // belt-and-braces check pins the contract guarantee at the handler
      // boundary in case the pipe ever changes.
      throw new UnprocessableEntityException(unprocessable('regionCode exceeds maximum length'));
    }
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-ranking-config-upsert',
      async () => this.service.upsert(regionCode, body),
    );
  }

  @Delete(':regionCode')
  @HttpCode(HttpStatus.OK)
  async deleteByRegion(
    @Param('regionCode', new ZodValidationPipe(SearchRankingConfigRegionCodeSchema))
    regionCode: string,
  ): Promise<DeleteSearchRankingConfigResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-ranking-config-delete',
      async () => {
        const result = await this.service.delete(regionCode);
        switch (result.outcome) {
          case 'deleted':
            return { outcome: 'deleted', regionCode };
          case 'not_found':
            throw new NotFoundException({
              type: 'about:blank',
              title: 'Not Found',
              status: HttpStatus.NOT_FOUND,
              detail: `No ranking-config row for regionCode "${regionCode}".`,
            });
          case 'global_protected':
            throw new UnprocessableEntityException(
              unprocessable(
                `The "${SEARCH_RANKING_REGION_CODE_GLOBAL}" row cannot be deleted — it is the load-bearing fallback for every region. Update its weights via PUT instead.`,
              ),
            );
        }
      },
    );
  }
}

function unprocessable(detail: string): {
  readonly type: 'about:blank';
  readonly title: 'Unprocessable Entity';
  readonly status: 422;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Unprocessable Entity',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    detail,
  };
}
