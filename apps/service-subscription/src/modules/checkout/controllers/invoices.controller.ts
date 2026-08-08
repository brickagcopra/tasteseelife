import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  HOUSEHOLD_SCOPE_HEADER,
  ListInvoicesQuerySchema,
  type InvoicesListResponse,
  type ListInvoicesQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { InvoicesService, type InvoicesFailure } from '../services/invoices.service';

/**
 * Invoices HTTP boundary (TS-124).
 *
 *   GET /api/v1/invoices?subscriptionId=...
 *
 * Returns a paginated list of Stripe invoices for the given local
 * subscription. Stripe is authoritative for invoice state; no local
 * persistence yet (see InvoicesService doc-comment).
 *
 * Authentication. Required (AccessTokenGuard).
 *
 * Authorization (TS-124-followup-scoping). The acting household comes
 * from the token's `tenantScope` — the gateway's
 * `HouseholdScopeInterceptor` resolves it from the caller's memberships
 * before any proxy runs — and is passed to the service as part of the
 * lookup predicate. **Never from the query string.** The caller supplies
 * a `subscriptionId`; whether that subscription is theirs is not their
 * claim to make. This is the same asymmetry as concierge emergency and
 * trust-safety intake, and it is the trust boundary.
 *
 * An actor with no household scope — staff, a provider, an academy
 * learner, or a family member in more than one household who has not
 * named which — gets a 400 explaining the header, decided from their own
 * token before any lookup happens, so it reveals nothing about any
 * subscription. A household actor naming a subscription that is not
 * theirs gets the same 404 as one naming a subscription that does not
 * exist.
 *
 * Pagination. Cursor-based via Stripe's `startingAfter` field. The
 * portal passes the previous page's last invoice id back as the cursor
 * for the next call.
 */
@Controller('api/v1/invoices')
@UseGuards(AccessTokenGuard)
export class InvoicesController {
  private readonly logger = new Logger(InvoicesController.name);

  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ListInvoicesQuerySchema))
  async list(
    @Query() query: ListInvoicesQuery,
    @Req() request: RequestWithContext,
  ): Promise<InvoicesListResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);
    this.logger.debug(
      {
        requesterUserId: ctx.userId,
        householdId,
        subscriptionId: query.subscriptionId,
        limit: query.limit,
      },
      'invoices.list',
    );
    const result = await this.invoices.list({
      subscriptionId: query.subscriptionId,
      householdId,
      requesterUserId: ctx.userId,
      limit: query.limit,
      ...(query.startingAfter !== undefined && { startingAfter: query.startingAfter }),
    });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return result.value;
  }
}

function throwFailure(failure: InvoicesFailure): never {
  switch (failure.reason) {
    case 'subscription_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `subscription not found: ${failure.subscriptionId}`,
      });
    case 'stripe_unavailable':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'upstream payment provider unavailable',
      });
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
 * Resolve the household the caller is acting in from the token's
 * `tenantScope`. Mirrors the wording used by concierge emergency and the
 * wellness surfaces so a family member in two households meets one
 * explanation across the platform, not four.
 *
 * A 400 rather than a 403: nothing has been refused about a resource
 * yet, and the caller can fix it themselves by naming a household.
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
