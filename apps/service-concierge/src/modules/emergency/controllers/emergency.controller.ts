import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  HOUSEHOLD_SCOPE_HEADER,
  TriggerEmergencyAssistanceRequestSchema,
  TriggerEmergencyAssistanceResponseSchema,
  type TriggerEmergencyAssistanceRequest,
  type TriggerEmergencyAssistanceResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { EmergencyService } from '../services/emergency.service';

/**
 * Emergency concierge-assistance HTTP boundary (TS-225; PRD §5.1 Tier 3;
 * PDD §16.1, §20.5).
 *
 *   POST /api/v1/concierge/emergency
 *     Trigger emergency concierge assistance. The household is resolved from
 *     the token's `tenantScope: {type:'household', householdId}` claim — no
 *     household id crosses the wire (the token is the household-membership
 *     trust boundary; service-concierge cannot read
 *     `household.household_members`, CLAUDE.md §2.3). Creates a high-severity
 *     `emergency_assistance` ticket (escalated on the `emergency_on_call`
 *     path, 1-hour SLA), routes it to the household's active dedicated
 *     concierge when one exists, and pages the on-call supervisor via
 *     PagerDuty. 201 + the created ticket.
 *
 * Idempotency. The endpoint wears `@Idempotent()` so a retried request (or a
 * panicked double-tap) with the same `Idempotency-Key` returns the cached
 * response rather than creating two tickets + two pages (CLAUDE.md §3.3 /
 * §17.5).
 *
 * No Tier-3 gating — emergency assistance is a safety surface reachable by
 * any household (the same deferral as TS-222 / TS-223; the Tier-3 positioning
 * lives in the UI copy, not a hard 403). The household-scope resolution still
 * holds: a non-household actor (admin / partner) has no "my household" to
 * trigger for and gets a 400.
 */
@Controller()
export class EmergencyController {
  constructor(private readonly emergency: EmergencyService) {}

  @Post('api/v1/concierge/emergency')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(TriggerEmergencyAssistanceRequestSchema))
  @Idempotent()
  async trigger(
    @Body() body: TriggerEmergencyAssistanceRequest,
    @Req() request: RequestWithContext,
  ): Promise<TriggerEmergencyAssistanceResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    const ticket = await this.emergency.triggerEmergency({
      householdId,
      category: body.category,
      note: body.note ?? null,
    });

    const response: TriggerEmergencyAssistanceResponse = { ticket };
    // Defence-in-depth: validate the response shape at the boundary so a
    // future drift between the service projection + contract surfaces here
    // rather than at the consumer.
    return TriggerEmergencyAssistanceResponseSchema.parse(response);
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
 * `tenantScope`. The emergency surface is for household-scoped actors only —
 * an admin (global scope) or partner (tenant scope) token has no "my
 * household" to trigger for, so it gets a 400 rather than a silent failure.
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
