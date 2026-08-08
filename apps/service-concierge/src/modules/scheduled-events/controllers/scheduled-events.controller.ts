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
  ConciergeScheduledEventsListResponseSchema,
  ListConciergeScheduledEventsQuerySchema,
  ScheduleConciergeEventRequestSchema,
  ScheduleConciergeEventResponseSchema,
  UpdateConciergeEventRequestSchema,
  UpdateConciergeEventResponseSchema,
  type ConciergeScheduledEventsListResponse,
  type ListConciergeScheduledEventsQuery,
  type ScheduleConciergeEventRequest,
  type ScheduleConciergeEventResponse,
  type UpdateConciergeEventRequest,
  type UpdateConciergeEventResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { ScheduledEventsService } from '../services/scheduled-events.service';

/**
 * Concierge scheduled-events HTTP boundary (TS-227; PRD §5.1 Tier 3 "social
 * outings · event dining", §6.6; PDD §10.6).
 *
 * The internal-staff surface where a concierge books the experiences that
 * fulfil a Tier-3 household's requests:
 *
 *   GET  /api/v1/admin/concierge/scheduled-events
 *     Events ordered by `scheduledStart` ascending, filterable by household /
 *     originating ticket / status / kind / upcoming-only. `concierge:read`.
 *
 *   POST /api/v1/admin/concierge/scheduled-events
 *     Schedule a new event (`householdId` in the body — the actor is
 *     global-scoped). A supplied `ticketId` must belong to the same household
 *     (404 missing / 409 mismatch). `concierge:write`.
 *
 *   PATCH /api/v1/admin/concierge/scheduled-events/:eventId
 *     Partial update / reschedule / status transition. A disallowed status
 *     move or an edit to a terminal event is a 409; a non-monotonic merged
 *     start/end pair is a 409. `concierge:write`.
 *
 * **Authorisation.** Every endpoint sits behind `AccessTokenGuard` (verify
 * the JWT + attach the RequestContext) followed by `PermissionGuard`, which
 * reads the `@RequirePermissions(...)` metadata (CLAUDE.md §3.2). The gateway
 * BFF enforces the same gate at the edge (defence-in-depth).
 *
 * **Idempotency.** The two write endpoints wear `@Idempotent()` so a retried
 * request with the same `Idempotency-Key` returns the cached response rather
 * than scheduling a duplicate event / re-applying the update (CLAUDE.md §3.3 /
 * §17.5).
 *
 * **Actor attribution.** The scheduling concierge's id is the authoritative
 * `userId` from the verified token — never read from the body — so
 * `created_by_user_id` + the structured logs capture who did what.
 */
@Controller()
export class ScheduledEventsController {
  constructor(private readonly events: ScheduledEventsService) {}

  @Get('api/v1/admin/concierge/scheduled-events')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListConciergeScheduledEventsQuerySchema))
    query: ListConciergeScheduledEventsQuery,
  ): Promise<ConciergeScheduledEventsListResponse> {
    const events = await this.events.listEvents({
      householdId: query.householdId,
      ticketId: query.ticketId,
      status: query.status,
      kind: query.kind,
      upcomingOnly: query.upcomingOnly,
      limit: query.limit,
    });
    const response: ConciergeScheduledEventsListResponse = { events: [...events] };
    return ConciergeScheduledEventsListResponseSchema.parse(response);
  }

  @Post('api/v1/admin/concierge/scheduled-events')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async schedule(
    @Body(new ZodValidationPipe(ScheduleConciergeEventRequestSchema))
    body: ScheduleConciergeEventRequest,
    @Req() request: RequestWithContext,
  ): Promise<ScheduleConciergeEventResponse> {
    const ctx = requireContext(request);
    const outcome = await this.events.scheduleEvent({ ...body, actorUserId: ctx.userId });
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
        detail: 'The supplied ticket belongs to a different household than the event.',
      });
    }
    const response: ScheduleConciergeEventResponse = { event: outcome.event };
    return ScheduleConciergeEventResponseSchema.parse(response);
  }

  @Patch('api/v1/admin/concierge/scheduled-events/:eventId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('eventId') eventId: string,
    @Body(new ZodValidationPipe(UpdateConciergeEventRequestSchema))
    body: UpdateConciergeEventRequest,
    @Req() request: RequestWithContext,
  ): Promise<UpdateConciergeEventResponse> {
    const ctx = requireContext(request);
    const outcome = await this.events.updateEvent({ ...body, eventId, actorUserId: ctx.userId });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw eventNotFound(eventId);
      if (outcome.reason === 'terminal') {
        throw conflict(`Cannot edit a concierge event in the terminal '${outcome.status}' state.`);
      }
      if (outcome.reason === 'invalid_transition') {
        throw conflict(
          `Cannot transition a concierge event from '${outcome.from}' to '${outcome.to}'.`,
        );
      }
      throw conflict('scheduledEnd must be after scheduledStart.');
    }
    const response: UpdateConciergeEventResponse = { event: outcome.event };
    return UpdateConciergeEventResponseSchema.parse(response);
  }
}

function eventNotFound(eventId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No concierge scheduled event found for id '${eventId}'.`,
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
