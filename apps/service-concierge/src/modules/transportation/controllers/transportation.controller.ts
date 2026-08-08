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
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  ConciergeTransportationListResponseSchema,
  ListConciergeTransportationQuerySchema,
  ScheduleConciergeTransportationRequestSchema,
  ScheduleConciergeTransportationResponseSchema,
  UpdateConciergeTransportationRequestSchema,
  UpdateConciergeTransportationResponseSchema,
  type ConciergeTransportationListResponse,
  type ListConciergeTransportationQuery,
  type ScheduleConciergeTransportationRequest,
  type ScheduleConciergeTransportationResponse,
  type UpdateConciergeTransportationRequest,
  type UpdateConciergeTransportationResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { TransportationService } from '../services/transportation.service';

/**
 * Concierge transportation HTTP boundary (TS-226; PRD §5.1 Tier 3
 * "transportation coordination", §6.6; PDD §10.6).
 *
 * The internal-staff surface where a concierge coordinates the rides that
 * fulfil a Tier-3 household's transportation needs:
 *
 *   GET  /api/v1/admin/concierge/transportation
 *     Rides ordered by `scheduledPickupAt` ascending, filterable by household /
 *     originating ticket / status / provider / upcoming-only. `concierge:read`.
 *
 *   POST /api/v1/admin/concierge/transportation
 *     Arrange a new ride (`householdId` in the body — the actor is
 *     global-scoped). A supplied `ticketId` must belong to the same household
 *     (404 missing / 409 mismatch). `concierge:write`.
 *
 *   PATCH /api/v1/admin/concierge/transportation/:requestId
 *     Partial update / reschedule / status transition / cancel. A disallowed
 *     status move or an edit to a terminal ride is a 409. `concierge:write`.
 *
 * **Authorisation.** Every endpoint sits behind `AccessTokenGuard` (verify the
 * JWT + attach the RequestContext) followed by `PermissionGuard`, which reads
 * the `@RequirePermissions(...)` metadata (CLAUDE.md §3.2). The gateway BFF
 * enforces the same gate at the edge (defence-in-depth). Sibling of the TS-227
 * `ScheduledEventsController`.
 *
 * **Idempotency.** The two write endpoints wear `@Idempotent()` so a retried
 * request with the same `Idempotency-Key` returns the cached response rather
 * than arranging a duplicate ride / re-applying the update (CLAUDE.md §3.3 /
 * §17.5).
 *
 * **Actor attribution.** The coordinating concierge's id is the authoritative
 * `userId` from the verified token — never read from the body — so
 * `created_by_user_id` + the structured logs capture who did what.
 */
@Controller()
export class TransportationController {
  constructor(private readonly transportation: TransportationService) {}

  @Get('api/v1/admin/concierge/transportation')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListConciergeTransportationQuerySchema))
    query: ListConciergeTransportationQuery,
  ): Promise<ConciergeTransportationListResponse> {
    const requests = await this.transportation.listRides({
      householdId: query.householdId,
      ticketId: query.ticketId,
      status: query.status,
      externalProvider: query.externalProvider,
      upcomingOnly: query.upcomingOnly,
      limit: query.limit,
    });
    const response: ConciergeTransportationListResponse = { requests: [...requests] };
    return ConciergeTransportationListResponseSchema.parse(response);
  }

  @Post('api/v1/admin/concierge/transportation')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async schedule(
    @Body(new ZodValidationPipe(ScheduleConciergeTransportationRequestSchema))
    body: ScheduleConciergeTransportationRequest,
    @Req() request: RequestWithContext,
  ): Promise<ScheduleConciergeTransportationResponse> {
    const ctx = requireContext(request);
    const outcome = await this.transportation.scheduleRide({ ...body, actorUserId: ctx.userId });
    if (!outcome.ok) {
      if (outcome.reason === 'ticket_not_found') {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: HttpStatus.NOT_FOUND,
          detail: `No concierge ticket found for id '${body.ticketId ?? ''}'.`,
        });
      }
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: HttpStatus.CONFLICT,
        detail: 'The supplied ticket belongs to a different household than the ride.',
      });
    }
    const response: ScheduleConciergeTransportationResponse = { request: outcome.request };
    return ScheduleConciergeTransportationResponseSchema.parse(response);
  }

  @Patch('api/v1/admin/concierge/transportation/:requestId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('requestId') requestId: string,
    @Body(new ZodValidationPipe(UpdateConciergeTransportationRequestSchema))
    body: UpdateConciergeTransportationRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateConciergeTransportationResponse> {
    const ctx = requireContext(request);
    const outcome = await this.transportation.updateRide({
      ...body,
      requestId,
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw rideNotFound(requestId);
      if (outcome.reason === 'terminal') {
        throw conflict(
          `Cannot edit a transportation request in the terminal '${outcome.status}' state.`,
        );
      }
      throw conflict(
        `Cannot transition a transportation request from '${outcome.from}' to '${outcome.to}'.`,
      );
    }
    const response: UpdateConciergeTransportationResponse = { request: outcome.request };
    return UpdateConciergeTransportationResponseSchema.parse(response);
  }
}

function rideNotFound(requestId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No concierge transportation request found for id '${requestId}'.`,
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
