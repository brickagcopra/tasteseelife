import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  ConciergeTicketsListResponseSchema,
  HOUSEHOLD_SCOPE_HEADER,
  ListMyConciergeRequestsQuerySchema,
  SubmitConciergeRequestRequestSchema,
  SubmitConciergeRequestResponseSchema,
  type ConciergeTicketsListResponse,
  type ListMyConciergeRequestsQuery,
  type SubmitConciergeRequestRequest,
  type SubmitConciergeRequestResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { TicketsService } from '../services/tickets.service';

/**
 * Concierge custom-request / service-request HTTP boundary (TS-223; PRD
 * §6.6 "Concierge Service Requests"; PDD §10.6).
 *
 * Family surfaces (behind `AccessTokenGuard` only — household-scoped):
 *
 *   POST /api/v1/concierge/requests
 *     Submit a concierge service request. The household is resolved from
 *     the token's `tenantScope: {type:'household', householdId}` claim — no
 *     household id crosses the wire (the token is the household-membership
 *     trust boundary; service-concierge cannot read
 *     `household.household_members`, CLAUDE.md §2.3). `service-concierge`
 *     routes the ticket to the household's active dedicated concierge (when
 *     one exists) and stamps a per-kind SLA. 201 + the created ticket.
 *
 *   GET  /api/v1/concierge/requests/me
 *     The household's submitted requests, newest-first.
 *
 * Idempotency. The submit endpoint wears `@Idempotent()` so a retried
 * request with the same `Idempotency-Key` returns the cached response
 * rather than inserting a duplicate ticket (CLAUDE.md §3.3 / §17.5).
 *
 * Tier-3 gating is intentionally NOT enforced here — that requires a
 * cross-service tier read (the same deferral as TS-222-followup-3). A
 * non-Tier-3 household with no dedicated concierge simply has its request
 * land in the unassigned `open` queue for the ops console (TS-224).
 */
@Controller()
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Post('api/v1/concierge/requests')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(SubmitConciergeRequestRequestSchema))
  @Idempotent()
  async submit(
    @Body() body: SubmitConciergeRequestRequest,
    @Req() request: RequestWithContext,
  ): Promise<SubmitConciergeRequestResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    const ticket = await this.tickets.submitRequest({
      householdId,
      kind: body.kind,
      subject: body.subject,
      body: body.body,
      requestedDate: body.requestedDate ?? null,
      partySize: body.partySize ?? null,
      theme: body.theme ?? null,
    });

    const response: SubmitConciergeRequestResponse = { ticket };
    // Defence-in-depth: validate the response shape at the boundary so a
    // future drift between the service projection + contract surfaces here
    // rather than at the consumer.
    return SubmitConciergeRequestResponseSchema.parse(response);
  }

  @Get('api/v1/concierge/requests/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listMine(
    @Query(new ZodValidationPipe(ListMyConciergeRequestsQuerySchema))
    query: ListMyConciergeRequestsQuery,
    @Req() request: RequestWithContext,
  ): Promise<ConciergeTicketsListResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    const tickets = await this.tickets.listForHousehold({ householdId, limit: query.limit });
    const response: ConciergeTicketsListResponse = { tickets: [...tickets] };
    return ConciergeTicketsListResponseSchema.parse(response);
  }
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

/**
 * Resolve the household the family actor is acting in from the token's
 * `tenantScope`. The concierge-request surface is for household-scoped
 * actors only — an admin (global scope) or partner (tenant scope) token has
 * no "my household" to submit for, so it gets a 400 rather than a silent
 * failure.
 */
function requireHouseholdScope(ctx: RequestContext): string {
  if (ctx.tenantScope.type !== 'household') {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail:
        `This endpoint is only available to household members. If you belong to more ` +
        `than one household, name the one you are acting in with the ` +
        `${HOUSEHOLD_SCOPE_HEADER} header.`,
    });
  }
  return ctx.tenantScope.householdId;
}
