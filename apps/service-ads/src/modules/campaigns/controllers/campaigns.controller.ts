import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  AdCampaignDetailResponseSchema,
  AdCampaignResponseSchema,
  AdCampaignsListResponseSchema,
  AdCreativeResponseSchema,
  CreateAdCampaignRequestSchema,
  ListAdCampaignsQuerySchema,
  UpdateAdCampaignRequestSchema,
  UpdateAdCreativeStatusRequestSchema,
  type AdCampaignDetailResponse,
  type AdCampaignResponse,
  type AdCampaignsListResponse,
  type AdCreativeResponse,
  type CreateAdCampaignRequest,
  type ListAdCampaignsQuery,
  type UpdateAdCampaignRequest,
  type UpdateAdCreativeStatusRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import { CampaignsService } from '../services/campaigns.service';

/**
 * Ad-campaign admin HTTP boundary (TS-271a; PRD §10.9; PDD §18.1, §8.2).
 *
 *   GET    /api/v1/admin/ads/campaigns                              — list.            `ads:read`.
 *   POST   /api/v1/admin/ads/campaigns                              — create.          `ads:write`.
 *   GET    /api/v1/admin/ads/campaigns/:campaignId                  — detail (tree).   `ads:read`.
 *   PATCH  /api/v1/admin/ads/campaigns/:campaignId                  — partial update.  `ads:write`.
 *   PATCH  /api/v1/admin/ads/campaigns/:campaignId/creatives/:creativeId — creative status. `ads:write`.
 *
 * **Authorisation.** Every endpoint sits behind `AccessTokenGuard` (verify the
 * JWT + attach the RequestContext) followed by `PermissionGuard`, which reads
 * the `@RequirePermissions(...)` metadata (CLAUDE.md §3.2). The gateway BFF
 * (TS-271b) enforces the same gate at the edge (defence-in-depth).
 *
 * **Idempotency.** The write endpoints wear `@Idempotent()` so a retried
 * request with the same `Idempotency-Key` returns the cached response rather
 * than re-applying the mutation (CLAUDE.md §3.3 / §17.5).
 *
 * **Actor attribution.** The acting admin's id is the authoritative `userId`
 * from the verified token — never read from the body.
 */
@Controller()
export class CampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @Get('api/v1/admin/ads/campaigns')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListAdCampaignsQuerySchema))
    query: ListAdCampaignsQuery,
  ): Promise<AdCampaignsListResponse> {
    const campaigns = await this.campaigns.listCampaigns({
      status: query.status,
      advertiserKind: query.advertiserKind,
      limit: query.limit,
    });
    return AdCampaignsListResponseSchema.parse({ campaigns: [...campaigns] });
  }

  @Post('api/v1/admin/ads/campaigns')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('ads:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateAdCampaignRequestSchema))
    body: CreateAdCampaignRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdCampaignResponse> {
    const ctx = requireContext(request);
    const outcome = await this.campaigns.createCampaign({
      ...body,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      throw unsupportedCurrency(body.currency);
    }
    return AdCampaignResponseSchema.parse({ campaign: outcome.campaign });
  }

  @Get('api/v1/admin/ads/campaigns/:campaignId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('campaignId') campaignId: string): Promise<AdCampaignDetailResponse> {
    const outcome = await this.campaigns.getCampaignDetail(campaignId);
    if (!outcome.ok) throw campaignNotFound(campaignId);
    return AdCampaignDetailResponseSchema.parse({ campaign: outcome.campaign });
  }

  @Patch('api/v1/admin/ads/campaigns/:campaignId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('campaignId') campaignId: string,
    @Body(new ZodValidationPipe(UpdateAdCampaignRequestSchema))
    body: UpdateAdCampaignRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdCampaignResponse> {
    const ctx = requireContext(request);
    const outcome = await this.campaigns.updateCampaign({
      ...body,
      campaignId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
          throw campaignNotFound(campaignId);
        case 'invalid_transition':
          throw conflict(`Cannot transition a campaign from '${outcome.from}' to '${outcome.to}'.`);
        case 'unsupported_currency':
          throw unsupportedCurrency(body.currency ?? '');
        case 'advertiser_required':
          throw unprocessable('advertiserId is required for a partner / provider campaign.');
        case 'advertiser_not_allowed':
          throw unprocessable('advertiserId must be null for an internal house ad.');
        case 'invalid_window':
          throw unprocessable('endAt must be after startAt.');
      }
    }
    return AdCampaignResponseSchema.parse({ campaign: outcome.campaign });
  }

  @Patch('api/v1/admin/ads/campaigns/:campaignId/creatives/:creativeId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async updateCreativeStatus(
    @Param('campaignId') campaignId: string,
    @Param('creativeId') creativeId: string,
    @Body(new ZodValidationPipe(UpdateAdCreativeStatusRequestSchema))
    body: UpdateAdCreativeStatusRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdCreativeResponse> {
    const ctx = requireContext(request);
    const outcome = await this.campaigns.updateCreativeStatus({
      campaignId,
      creativeId,
      status: body.status,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw creativeNotFound(campaignId, creativeId);
      throw conflict(`Cannot transition a creative from '${outcome.from}' to '${outcome.to}'.`);
    }
    return AdCreativeResponseSchema.parse({ creative: outcome.creative });
  }
}

function campaignNotFound(campaignId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No ad campaign found for id '${campaignId}'.`,
  });
}

function creativeNotFound(campaignId: string, creativeId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No creative '${creativeId}' found on campaign '${campaignId}'.`,
  });
}

function conflict(detail: string): ConflictException {
  return new ConflictException({
    type: 'about:blank',
    title: 'Conflict',
    status: HttpStatus.CONFLICT,
    detail,
  });
}

function unprocessable(detail: string): UnprocessableEntityException {
  return new UnprocessableEntityException({
    type: 'about:blank',
    title: 'Unprocessable Entity',
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    detail,
  });
}

function unsupportedCurrency(currency: string): UnprocessableEntityException {
  return unprocessable(`Currency '${currency}' is not supported. Phase 1 is USD-only.`);
}

function requireContext(request: RequestWithContext): RequestContext {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}
