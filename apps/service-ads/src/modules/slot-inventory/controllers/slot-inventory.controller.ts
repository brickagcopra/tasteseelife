import {
  Body,
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
  ConflictException,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  AdPlacementsListResponseSchema,
  AdSlotScheduleResponseSchema,
  AdSlotSchedulesListResponseSchema,
  CreateAdSlotScheduleRequestSchema,
  ListAdSlotSchedulesQuerySchema,
  UpdateAdSlotScheduleRequestSchema,
  type AdPlacementsListResponse,
  type AdSlotScheduleResponse,
  type AdSlotSchedulesListResponse,
  type CreateAdSlotScheduleRequest,
  type ListAdSlotSchedulesQuery,
  type UpdateAdSlotScheduleRequest,
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
import { SlotInventoryService } from '../services/slot-inventory.service';

/**
 * Slot-inventory admin HTTP boundary (TS-272a; PRD §10.9; PDD §18.1).
 *
 *   GET    /api/v1/admin/ads/placements                     — seeded slots.        `ads:read`.
 *   GET    /api/v1/admin/ads/slot-schedules                 — list (filtered).     `ads:read`.
 *   POST   /api/v1/admin/ads/slot-schedules                 — book a campaign.     `ads:write`.
 *   GET    /api/v1/admin/ads/slot-schedules/:scheduleId     — detail.              `ads:read`.
 *   PATCH  /api/v1/admin/ads/slot-schedules/:scheduleId     — window/priority/status. `ads:write`.
 *
 * **Authorisation.** Every endpoint sits behind `AccessTokenGuard` followed by
 * `PermissionGuard`, which reads the `@RequirePermissions(...)` metadata
 * (CLAUDE.md §3.2). The gateway BFF (TS-272b) enforces the same gate at the
 * edge (defence-in-depth).
 *
 * **Idempotency.** The write endpoints wear `@Idempotent()` so a retried
 * request with the same `Idempotency-Key` returns the cached response.
 *
 * **Actor attribution.** The acting admin's id is the authoritative `userId`
 * from the verified token — never read from the body.
 */
@Controller()
export class SlotInventoryController {
  constructor(private readonly slots: SlotInventoryService) {}

  @Get('api/v1/admin/ads/placements')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async listPlacements(): Promise<AdPlacementsListResponse> {
    const placements = await this.slots.listPlacements();
    return AdPlacementsListResponseSchema.parse({ placements: [...placements] });
  }

  @Get('api/v1/admin/ads/slot-schedules')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async listSchedules(
    @Query(new ZodValidationPipe(ListAdSlotSchedulesQuerySchema))
    query: ListAdSlotSchedulesQuery,
  ): Promise<AdSlotSchedulesListResponse> {
    const schedules = await this.slots.listSchedules({
      placementId: query.placementId,
      campaignId: query.campaignId,
      status: query.status,
      limit: query.limit,
    });
    return AdSlotSchedulesListResponseSchema.parse({ schedules: [...schedules] });
  }

  @Post('api/v1/admin/ads/slot-schedules')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('ads:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateAdSlotScheduleRequestSchema))
    body: CreateAdSlotScheduleRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdSlotScheduleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.slots.createSchedule({
      ...body,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'placement_not_found':
          throw unprocessable(`No placement found for id '${body.placementId}'.`);
        case 'campaign_not_found':
          throw unprocessable(`No campaign found for id '${body.campaignId}'.`);
        case 'incompatible_creative_kind': {
          const approved =
            outcome.approvedKinds.length === 0 ? 'none' : outcome.approvedKinds.join(', ');
          throw unprocessable(
            `Campaign '${body.campaignId}' has no approved creative compatible with placement ` +
              `'${body.placementId}' (placement supports: ${outcome.supportedKinds.join(', ')}; ` +
              `campaign approved creative kinds: ${approved}).`,
          );
        }
      }
    }
    return AdSlotScheduleResponseSchema.parse({ schedule: outcome.schedule });
  }

  @Get('api/v1/admin/ads/slot-schedules/:scheduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('scheduleId') scheduleId: string): Promise<AdSlotScheduleResponse> {
    const outcome = await this.slots.getSchedule(scheduleId);
    if (!outcome.ok) throw scheduleNotFound(scheduleId);
    return AdSlotScheduleResponseSchema.parse({ schedule: outcome.schedule });
  }

  @Patch('api/v1/admin/ads/slot-schedules/:scheduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ads:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('scheduleId') scheduleId: string,
    @Body(new ZodValidationPipe(UpdateAdSlotScheduleRequestSchema))
    body: UpdateAdSlotScheduleRequest,
    @Req() request: RequestWithContext,
  ): Promise<AdSlotScheduleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.slots.updateSchedule({
      ...body,
      scheduleId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
          throw scheduleNotFound(scheduleId);
        case 'invalid_transition':
          throw conflict(
            `Cannot transition a slot schedule from '${outcome.from}' to '${outcome.to}'.`,
          );
        case 'invalid_window':
          throw unprocessable('endAt must be after startAt.');
      }
    }
    return AdSlotScheduleResponseSchema.parse({ schedule: outcome.schedule });
  }
}

function scheduleNotFound(scheduleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No slot schedule found for id '${scheduleId}'.`,
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
