import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  AddConciergeTicketNoteRequestSchema,
  AddConciergeTicketNoteResponseSchema,
  ConciergeOpsTicketDetailResponseSchema,
  ConciergeOpsTicketsListResponseSchema,
  EscalateConciergeTicketRequestSchema,
  EscalateConciergeTicketResponseSchema,
  ListConciergeOpsTicketsQuerySchema,
  TransitionConciergeTicketRequestSchema,
  TransitionConciergeTicketResponseSchema,
  type AddConciergeTicketNoteRequest,
  type AddConciergeTicketNoteResponse,
  type ConciergeOpsTicketDetailResponse,
  type ConciergeOpsTicketsListResponse,
  type EscalateConciergeTicketRequest,
  type EscalateConciergeTicketResponse,
  type ListConciergeOpsTicketsQuery,
  type TransitionConciergeTicketRequest,
  type TransitionConciergeTicketResponse,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { OpsConsoleService } from '../services/ops-console.service';

/**
 * Concierge ops-console HTTP boundary (TS-224; PRD §10.6 "Concierge
 * Operations"; PDD §10.6).
 *
 * The internal-staff surface for working the concierge ticket queue that
 * TS-223 fills:
 *
 *   GET  /api/v1/admin/concierge/tickets
 *     The SLA-ordered queue across every household (defaults to non-terminal
 *     tickets). `concierge:read`.
 *
 *   GET  /api/v1/admin/concierge/tickets/:ticketId
 *     A single ticket + its internal-notes timeline. 404 when it does not
 *     resolve. `concierge:read`.
 *
 *   POST /api/v1/admin/concierge/tickets/:ticketId/transition
 *     Move the ticket through its lifecycle (validated against the transition
 *     matrix — a disallowed move is a 409). `concierge:write`.
 *
 *   POST /api/v1/admin/concierge/tickets/:ticketId/escalate
 *     Set the routing path + move to `escalated` (a terminal ticket is a 409).
 *     `concierge:write`.
 *
 *   POST /api/v1/admin/concierge/tickets/:ticketId/notes
 *     Append an internal note. `concierge:write`.
 *
 * **Authorisation.** Every endpoint sits behind `AccessTokenGuard` (verify
 * the JWT + attach the RequestContext) followed by `PermissionGuard`, which
 * reads the `@RequirePermissions(...)` metadata: `concierge:read` for the
 * reads, `concierge:write` for the mutations (CLAUDE.md §3.2). The gateway
 * BFF enforces the same gate at the edge (defence-in-depth).
 *
 * **Idempotency.** The three write endpoints wear `@Idempotent()` so a
 * retried request with the same `Idempotency-Key` returns the cached response
 * rather than re-applying the transition / re-inserting a duplicate note
 * (CLAUDE.md §3.3 / §17.5).
 *
 * **Actor attribution.** The acting ops staff member's id is the authoritative
 * `userId` from the verified token — never read from the body — so internal
 * notes + the structured logs capture who did what.
 */
@Controller()
export class OpsConsoleController {
  constructor(private readonly ops: OpsConsoleService) {}

  @Get('api/v1/admin/concierge/tickets')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async listQueue(
    @Query(new ZodValidationPipe(ListConciergeOpsTicketsQuerySchema))
    query: ListConciergeOpsTicketsQuery,
  ): Promise<ConciergeOpsTicketsListResponse> {
    const tickets = await this.ops.listQueue({
      status: query.status,
      escalationPath: query.escalationPath,
      kind: query.kind,
      householdId: query.householdId,
      limit: query.limit,
    });
    const response: ConciergeOpsTicketsListResponse = { tickets: [...tickets] };
    return ConciergeOpsTicketsListResponseSchema.parse(response);
  }

  @Get('api/v1/admin/concierge/tickets/:ticketId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async getTicket(@Param('ticketId') ticketId: string): Promise<ConciergeOpsTicketDetailResponse> {
    const detail = await this.ops.getTicketDetail(ticketId);
    if (detail === null) throw ticketNotFound(ticketId);
    const response: ConciergeOpsTicketDetailResponse = {
      ticket: detail.ticket,
      notes: [...detail.notes],
    };
    return ConciergeOpsTicketDetailResponseSchema.parse(response);
  }

  @Post('api/v1/admin/concierge/tickets/:ticketId/transition')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async transition(
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(TransitionConciergeTicketRequestSchema))
    body: TransitionConciergeTicketRequest,
    @Req() request: RequestWithContext,
  ): Promise<TransitionConciergeTicketResponse> {
    const ctx = requireContext(request);
    const outcome = await this.ops.transition({
      ticketId,
      actorUserId: ctx.userId,
      targetStatus: body.targetStatus,
      note: body.note,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw ticketNotFound(ticketId);
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: HttpStatus.CONFLICT,
        detail: `Cannot transition a concierge ticket from '${outcome.from}' to '${outcome.to}'.`,
      });
    }
    const response: TransitionConciergeTicketResponse = { ticket: outcome.ticket };
    return TransitionConciergeTicketResponseSchema.parse(response);
  }

  @Post('api/v1/admin/concierge/tickets/:ticketId/escalate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async escalate(
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(EscalateConciergeTicketRequestSchema))
    body: EscalateConciergeTicketRequest,
    @Req() request: RequestWithContext,
  ): Promise<EscalateConciergeTicketResponse> {
    const ctx = requireContext(request);
    const outcome = await this.ops.escalate({
      ticketId,
      actorUserId: ctx.userId,
      escalationPath: body.escalationPath,
      note: body.note,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw ticketNotFound(ticketId);
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: HttpStatus.CONFLICT,
        detail: `Cannot escalate a concierge ticket in the terminal '${outcome.status}' state.`,
      });
    }
    const response: EscalateConciergeTicketResponse = { ticket: outcome.ticket };
    return EscalateConciergeTicketResponseSchema.parse(response);
  }

  @Post('api/v1/admin/concierge/tickets/:ticketId/notes')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('concierge:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async addNote(
    @Param('ticketId') ticketId: string,
    @Body(new ZodValidationPipe(AddConciergeTicketNoteRequestSchema))
    body: AddConciergeTicketNoteRequest,
    @Req() request: RequestWithContext,
  ): Promise<AddConciergeTicketNoteResponse> {
    const ctx = requireContext(request);
    const outcome = await this.ops.addNote({
      ticketId,
      actorUserId: ctx.userId,
      body: body.body,
    });
    if (!outcome.ok) throw ticketNotFound(ticketId);
    const response: AddConciergeTicketNoteResponse = { note: outcome.note };
    return AddConciergeTicketNoteResponseSchema.parse(response);
  }
}

function ticketNotFound(ticketId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No concierge ticket found for id '${ticketId}'.`,
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
