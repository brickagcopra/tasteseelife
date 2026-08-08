import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  CreateBillingPortalSessionRequestSchema,
  HOUSEHOLD_SCOPE_HEADER,
  type BillingPortalSessionResponse,
  type CreateBillingPortalSessionRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import {
  BillingPortalService,
  type BillingPortalFailure,
} from '../services/billing-portal.service';

/**
 * Stripe Billing Portal HTTP boundary
 * (TS-042-followup-3a3-followup-1).
 *
 *   POST /api/v1/billing/portal-sessions
 *
 * Mints a short-lived Stripe-hosted portal session for the caller's own
 * household and returns the URL to redirect to. This is the surface the
 * dunning ladder's call to action needs: until it existed, a family told
 * their payment had failed had nowhere on the platform to fix it.
 *
 * **No request body, no ids on the wire.** The Stripe customer is
 * resolved from the token's `tenantScope`; the return URL comes from
 * server config. Both are deliberate: a portal session confers full
 * billing control including cancellation, and a caller-supplied
 * `return_url` would make this an open redirect. The empty body is
 * `.strict()`-validated so a client sending `{"customerId": ...}` gets a
 * 400 rather than having the field quietly dropped.
 *
 * **A POST, and idempotent.** It creates a Stripe object, so it is a
 * write (CLAUDE.md §3.3). The replay cache matters more here than
 * usual: a portal URL is single-use, so a double-submit that minted two
 * sessions would hand the family a link that may already be spent. A
 * genuine second visit sends a new key and gets a new session.
 *
 * Status codes:
 *   201 Created       — body is the BillingPortalSessionResponse.
 *   400 Bad Request   — body carried fields, or the caller has no
 *                       household scope.
 *   401 Unauthorized  — missing / invalid access token.
 *   404 Not Found     — the household has no family subscription.
 *   422 Unprocessable — the subscription carries no Stripe customer (a
 *                       data defect, not a customer problem).
 *   500 Internal      — Stripe call failed.
 */
@Controller('api/v1/billing/portal-sessions')
@UseGuards(AccessTokenGuard)
export class BillingPortalController {
  private readonly logger = new Logger(BillingPortalController.name);

  constructor(private readonly portal: BillingPortalService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(CreateBillingPortalSessionRequestSchema))
  async create(
    @Body() _body: CreateBillingPortalSessionRequest,
    @Req() request: RequestWithContext,
  ): Promise<BillingPortalSessionResponse> {
    const ctx = requireContext(request);
    const householdId = requireHouseholdScope(ctx);

    this.logger.debug({ requesterUserId: ctx.userId, householdId }, 'billing-portal.create');

    const result = await this.portal.createSession({
      householdId,
      requesterUserId: ctx.userId,
    });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return result.value;
  }
}

function throwFailure(failure: BillingPortalFailure): never {
  switch (failure.reason) {
    case 'no_subscription':
      // No id echoed back: the caller named nothing, so there is nothing
      // to name in the refusal.
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No active plan found for your household.',
      });
    case 'no_stripe_customer':
      // 422 rather than 404 or 500: the request was well-formed and the
      // subscription exists, but its state cannot satisfy this call.
      // Telling a family "you have no plan" when they demonstrably do is
      // the one answer that would send them somewhere useless.
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'This plan is not yet linked to a billing profile.',
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
 * `tenantScope`. Same helper shape, and the same wording, as concierge
 * emergency / the wellness surfaces / the invoice list.
 *
 * A provider or an academy learner lands here too. They are refused for
 * the same reason as staff — this endpoint only knows how to build a
 * family's portal (see `BillingPortalService`) — and the wording is the
 * household one rather than a provider-specific apology, which would
 * promise a surface TS-042-followup-3a1a has not unblocked yet.
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
