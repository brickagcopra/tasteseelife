import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  HOUSEHOLD_SCOPE_HEADER,
  MySubscriptionResponseSchema,
  type MySubscriptionResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { MySubscriptionService } from '../services/my-subscription.service';

/**
 * The family's own membership (TS-042-followup-3a3-followup-1a).
 *
 *   GET /api/v1/subscriptions/me
 *
 * The first family-facing subscription read on the platform. Until this
 * existed a household could buy a plan at checkout and then never see it
 * again: creation was a POST, the only reads were the admin console's
 * and an id-keyed internal lookup, and neither is reachable from the
 * family portal.
 *
 * **`/me`, not `/:id`.** There is no id to pass — the caller is the
 * subject, and the household comes from the token's `tenantScope`. That
 * removes the failure mode TS-124-followup-scoping had to close on the
 * invoice list: a route that takes no resource id cannot be pointed at
 * someone else's resource. The route is declared BEFORE any `:id`
 * pattern on this base path would be, so `me` can never be read as one.
 *
 * **A household with no membership gets 200 with `subscription: null`**,
 * not a 404. "You have no plan" is a true answer to "what is my plan",
 * and a household that has never subscribed is not an error condition.
 */
@Controller('api/v1/subscriptions')
@UseGuards(AccessTokenGuard)
export class MySubscriptionController {
  private readonly logger = new Logger(MySubscriptionController.name);

  constructor(private readonly mine: MySubscriptionService) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  async read(@Req() request: RequestWithContext): Promise<MySubscriptionResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    this.logger.debug({ requesterUserId: ctx.userId, householdId }, 'subscriptions.me');

    const subscription = await this.mine.read({
      householdId,
      requesterUserId: ctx.userId,
    });

    // Boundary re-parse: this DTO is deliberately narrower than the
    // operator's record, and the fields it omits are the disclosure
    // control. `.strict()` turns a widened `select` into a 500 here
    // rather than a leak at the browser.
    return MySubscriptionResponseSchema.parse({ subscription });
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
