import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import {
  ResolveSponsoredListingsRequestSchema,
  type ResolveSponsoredListingsRequest,
  type ResolveSponsoredListingsResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { InternalSharedSecretGuard } from '../../../common/guards/internal-shared-secret.guard';
import { SponsoredListingsService } from '../services/sponsored-listings.service';

/**
 * Internal sponsored-listings resolve surface (TS-218a; PRD §10.9; PDD §18.1,
 * §18.3).
 *
 *   `POST /api/v1/internal/ads/sponsored-listings/resolve`
 *
 * Called by `service-search` at query time to fill the reserved sponsored
 * slot(s) on a provider-search results page. Pinned by
 * `InternalSharedSecretGuard` (`ADS_INTERNAL_API_KEY`) — a cluster-internal,
 * never client-facing surface; NetworkPolicy (TS-151) further restricts it to
 * in-cluster callers.
 *
 * **Tenant-scoping.** The guard does NOT seed a `request.requestContext` (the
 * `service-search` caller is a cluster-internal service, not a logged-in user).
 * No `runWithoutTenantContext` wrapper is needed because every model this path
 * reads (`AdCampaign`, `AdCreative`, `AdTargetingRule`) is an `unscopedModel`
 * (see `app.module.ts`) — the tenant-scope gate short-circuits to
 * `proceed_unscoped_model` before any request-context check. (This is the same
 * posture documented on `AdTargetingRuleRepository`.)
 */
@Controller('api/v1/internal/ads/sponsored-listings')
@UseGuards(InternalSharedSecretGuard)
export class SponsoredListingsController {
  constructor(private readonly service: SponsoredListingsService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  async resolve(
    @Body(new ZodValidationPipe(ResolveSponsoredListingsRequestSchema))
    body: ResolveSponsoredListingsRequest,
  ): Promise<ResolveSponsoredListingsResponse> {
    return this.service.resolve({
      slotCode: body.slotCode,
      audience: body.audience,
      candidateProviderIds: body.candidateProviderIds,
      limit: body.limit,
    });
  }
}
