import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  CreateCheckoutSessionRequestSchema,
  FinalizeCheckoutSessionRequestSchema,
  SUBSCRIPTION_IDEMPOTENCY_KEY_MAX_LENGTH,
  SUBSCRIPTION_IDEMPOTENCY_KEY_MIN_LENGTH,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type FinalizeCheckoutSessionRequest,
  type GetCheckoutSessionResponse,
  type SubscriptionResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import {
  CheckoutSessionsService,
  type CheckoutSessionsFailure,
} from '../services/checkout-sessions.service';

/**
 * Stripe Checkout sessions HTTP boundary (TS-124).
 *
 * Three endpoints under `/api/v1/subscriptions/checkout-sessions`:
 *
 *   POST   /                  Create a Stripe Checkout Session in
 *                             `subscription` mode and return the hosted
 *                             URL the portal redirects to. Idempotent
 *                             on `Idempotency-Key`.
 *
 *   GET    /:id               Retrieve session status. Pure read.
 *
 *   POST   /:id/finalize      Promote a completed session into a local
 *                             Subscription row. Idempotent on the
 *                             underlying `stripeSubscriptionId` — the
 *                             portal can hit this on every success-page
 *                             load without producing duplicate rows.
 *
 * Authentication. Every endpoint requires a valid Bearer access token
 * (CLAUDE.md §3.1). The `AccessTokenGuard` attaches `requestContext`;
 * the service logs the userId on every audit-history row.
 *
 * Authorization. Phase 1 is authentication-only — full row-level
 * scoping arrives via TS-141. The audit log is the trust gate.
 *
 * Idempotency. Two layers, same as
 * `SubscriptionsController`:
 *   1. Local replay cache (`@Idempotent()` + Redis backend).
 *   2. Stripe-side dedup via the same key with `:phase` suffixes.
 */
@Controller('api/v1/subscriptions/checkout-sessions')
@UseGuards(AccessTokenGuard)
export class CheckoutSessionsController {
  private readonly logger = new Logger(CheckoutSessionsController.name);

  constructor(private readonly checkout: CheckoutSessionsService) {}

  /**
   * POST /api/v1/subscriptions/checkout-sessions — create session.
   *
   * Status codes:
   *   201 Created       — body is the CreateCheckoutSessionResponse.
   *   400 Bad Request   — payload failed validation OR plan
   *                       customerGroup did not match the request.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — plan does not exist or is inactive.
   *   500 Internal      — Stripe call failed; generic body.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(CreateCheckoutSessionRequestSchema))
  async create(
    @Body() body: CreateCheckoutSessionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateCheckoutSessionResponse> {
    const requesterUserId = requireUserId(request);
    const validatedKey = validateIdempotencyKey(idempotencyKey);

    if (validatedKey !== null) {
      this.logger.debug(
        { planId: body.planId, idempotencyKey: redactKey(validatedKey) },
        'checkout-sessions.create carried Idempotency-Key',
      );
    }

    const result = await this.checkout.create({
      request: body,
      requesterUserId,
      ...(validatedKey !== null && { idempotencyKey: validatedKey }),
    });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return result.value;
  }

  /**
   * GET /api/v1/subscriptions/checkout-sessions/:id — read session status.
   *
   * Status codes:
   *   200 OK            — body is the GetCheckoutSessionResponse.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — session id is unknown to Stripe.
   *   500 Internal      — Stripe call failed.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async get(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<GetCheckoutSessionResponse> {
    const requesterUserId = requireUserId(request);
    const result = await this.checkout.get({ sessionId: id, requesterUserId });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return result.value;
  }

  /**
   * POST /api/v1/subscriptions/checkout-sessions/:id/finalize — promote
   * a completed session into a local subscription.
   *
   * Status codes:
   *   200 OK            — body is the SubscriptionResponse.
   *   400 Bad Request   — body is non-empty (we reject stray fields).
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — session does not exist, OR session refers to a
   *                       plan that the catalog no longer carries.
   *   422 Unprocessable — session has not completed payment yet, OR the
   *                       session was created outside our flow and is
   *                       missing the required metadata.
   *   500 Internal      — Stripe call failed.
   */
  @Post(':id/finalize')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async finalize(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(FinalizeCheckoutSessionRequestSchema))
    _body: FinalizeCheckoutSessionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubscriptionResponse> {
    const requesterUserId = requireUserId(request);
    const validatedKey = validateIdempotencyKey(idempotencyKey);
    const result = await this.checkout.finalize({
      sessionId: id,
      requesterUserId,
      ...(validatedKey !== null && { idempotencyKey: validatedKey }),
    });
    if (!result.ok) {
      throwFailure(result.error);
    }
    return result.value;
  }
}

/**
 * Translate a CheckoutSessionsFailure into the appropriate HTTP exception.
 * Always throws — the controller's call site uses the function's `never`
 * return for control-flow narrowing.
 */
function throwFailure(failure: CheckoutSessionsFailure): never {
  switch (failure.reason) {
    case 'plan_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `plan not found: ${failure.planId}`,
      });
    case 'plan_inactive':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `plan is inactive: ${failure.planId}`,
      });
    case 'plan_group_mismatch':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `plan customerGroup mismatch (expected ${failure.expected}, plan is ${failure.actual})`,
      });
    case 'session_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `checkout session not found: ${failure.sessionId}`,
      });
    case 'session_not_subscription_mode':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `checkout session ${failure.sessionId} is not in subscription mode`,
      });
    case 'session_not_complete':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `checkout session ${failure.sessionId} is not complete (${failure.status})`,
      });
    case 'session_metadata_invalid':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `checkout session ${failure.sessionId} is missing required metadata key: ${failure.missingKey}`,
      });
    case 'subscription_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `subscription not found for stripe id: ${failure.stripeSubscriptionId}`,
      });
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'coupon_invalid':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `coupon ${failure.couponCode} cannot be applied: ${failure.failureReason}`,
        failureReason: failure.failureReason,
        couponCode: failure.couponCode,
      });
    case 'stripe_unavailable':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'upstream payment provider unavailable',
      });
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'event payload validation failed',
      });
  }
}

function requireUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function validateIdempotencyKey(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length < SUBSCRIPTION_IDEMPOTENCY_KEY_MIN_LENGTH) return null;
  if (trimmed.length > SUBSCRIPTION_IDEMPOTENCY_KEY_MAX_LENGTH) return null;
  return trimmed;
}

function redactKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
