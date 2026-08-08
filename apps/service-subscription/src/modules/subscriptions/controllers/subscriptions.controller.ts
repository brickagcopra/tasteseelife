import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Headers,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  CancelSubscriptionRequestSchema,
  CreateSubscriptionRequestSchema,
  PatchSubscriptionRequestSchema,
  PauseSubscriptionRequestSchema,
  ResumeSubscriptionRequestSchema,
  SUBSCRIPTION_IDEMPOTENCY_KEY_MAX_LENGTH,
  SUBSCRIPTION_IDEMPOTENCY_KEY_MIN_LENGTH,
  type CancelSubscriptionRequest,
  type CreateSubscriptionRequest,
  type PatchSubscriptionRequest,
  type PauseSubscriptionRequest,
  type ResumeSubscriptionRequest,
  type SubscriptionResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { DunningService, type DunningFailure } from '../services/dunning.service';
import { SubscriptionsService, type SubscriptionsFailure } from '../services/subscriptions.service';

/**
 * Subscription HTTP boundary (TS-041b).
 *
 * Three endpoints:
 *
 *   POST   /api/v1/subscriptions
 *     Create a subscription. Validates the plan + customer-group match,
 *     resolves (or creates) the Stripe Customer, attaches the payment
 *     method, creates the Stripe Subscription, then persists the
 *     subscription row + the initial audit-history entry transactionally.
 *
 *   PATCH  /api/v1/subscriptions/:id
 *     Change the plan and/or the default payment method. Plan changes
 *     trigger a Stripe proration; payment-method changes attach +
 *     promote to default.
 *
 *   DELETE /api/v1/subscriptions/:id
 *     Cancel — at-period-end (default) or immediately. Stamps cancel
 *     reason + canceled_at on the row; emits a `canceled` history entry.
 *
 * Authentication. Every endpoint requires a valid Bearer access token
 * minted by `service-identity`. The `AccessTokenGuard` attaches a
 * `requestContext` carrying the caller's userId; the
 * SubscriptionsService logs the userId on every audit-history row so
 * misuse is at least traceable.
 *
 * Authorization. Phase 1 enforces authentication only. The full
 * "family-payer can subscribe their household; provider can subscribe
 * themselves" row-level model arrives via TS-141's tenant-scoping
 * middleware once cross-service household-membership lookups are
 * feasible. Until then the audit log is the trust gate.
 *
 * Idempotency. Two layers:
 *
 *   1. Local replay cache (TS-044). Every write endpoint is decorated
 *      with `@Idempotent()` so the global `IdempotencyInterceptor` from
 *      `@taste-and-see/nest-idempotency` claims a Redis slot per
 *      `Idempotency-Key`, body-hashes the request, and replays the
 *      cached HTTP response (status + body + content-type) for any
 *      retry within the 24h TTL. A same-key-different-body retry
 *      returns 409 with a problem-shaped body. A concurrent in-flight
 *      retry returns 409 + `Retry-After`.
 *
 *   2. Stripe-side dedup. The same key is forwarded to Stripe with a
 *      `<key>:<phase>` suffix so the customer-create, sub-create,
 *      payment-method-attach, etc. each de-dup independently within
 *      Stripe's 24h window. This protects partial-success retries (we
 *      crashed after Stripe call but before persist).
 *
 * The local cache wraps the Stripe-side dedup: a replayed retry never
 * even reaches the service / Stripe; only a request that misses the
 * local cache (Redis outage, cache eviction, or a fresh Idempotency-Key)
 * makes it through.
 */
@Controller('api/v1/subscriptions')
@UseGuards(AccessTokenGuard)
export class SubscriptionsController {
  private readonly logger = new Logger(SubscriptionsController.name);

  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly dunning: DunningService,
  ) {}

  /**
   * POST /api/v1/subscriptions — create.
   *
   * Status codes:
   *   201 Created       — body is the SubscriptionResponse.
   *   400 Bad Request   — payload failed Zod validation, or plan
   *                       customerGroup did not match the request.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — plan does not exist or is inactive.
   *   502 Bad Gateway   — Stripe call failed. Mapped to 500 with a
   *                       generic body so the controller doesn't leak
   *                       upstream identifiers in the response.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(CreateSubscriptionRequestSchema))
  async create(
    @Body() body: CreateSubscriptionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubscriptionResponse> {
    const requesterUserId = requireUserId(request);
    const validatedKey = validateIdempotencyKey(idempotencyKey);
    if (validatedKey !== null) {
      this.logger.debug(
        { idempotencyKey: redactKey(validatedKey), planId: body.planId },
        'subscriptions.create carried Idempotency-Key',
      );
    }

    const result = await this.subscriptions.create({
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
   * PATCH /api/v1/subscriptions/:id — change plan and/or payment method.
   *
   * Status codes:
   *   200 OK            — body is the updated SubscriptionResponse.
   *   400 Bad Request   — payload validation failed, or new plan's
   *                       customerGroup did not match the existing one.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — subscription does not exist.
   *   500 Internal      — Stripe call failed; opaque body.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async patch(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PatchSubscriptionRequestSchema)) body: PatchSubscriptionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubscriptionResponse> {
    const requesterUserId = requireUserId(request);
    const validatedKey = validateIdempotencyKey(idempotencyKey);

    const result = await this.subscriptions.patch({
      subscriptionId: id,
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
   * DELETE /api/v1/subscriptions/:id — cancel (immediate or at-period-end).
   *
   * Status codes:
   *   200 OK            — body is the canceled SubscriptionResponse.
   *   400 Bad Request   — payload validation failed.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — subscription does not exist.
   *   409 Conflict      — subscription is already canceled.
   *   500 Internal      — Stripe call failed; opaque body.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async cancel(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(CancelSubscriptionRequestSchema)) body: CancelSubscriptionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubscriptionResponse> {
    const requesterUserId = requireUserId(request);
    const validatedKey = validateIdempotencyKey(idempotencyKey);

    const result = await this.subscriptions.cancel({
      subscriptionId: id,
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
   * POST /api/v1/subscriptions/:id/pause — TS-042 pause/resume.
   *
   * Suspends Stripe collection via `pause_collection: {behavior: 'void'}`
   * and transitions the platform row to `paused`. An optional `resumesAt`
   * scheduled resume timestamp is forwarded to Stripe; the row preserves
   * the dunning counters so a `resume` later picks up the prior cycle's
   * state.
   *
   * Status codes:
   *   200 OK            — body is the paused SubscriptionResponse.
   *   400 Bad Request   — payload validation failed.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — subscription does not exist.
   *   422 Unprocessable — subscription is in a state that cannot pause
   *                       (`canceled`, `unpaid`, `incomplete*`, or
   *                       already `paused`). Body lists the expected
   *                       states for the client.
   *   500 Internal      — Stripe call failed; opaque body.
   */
  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async pause(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PauseSubscriptionRequestSchema)) body: PauseSubscriptionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubscriptionResponse> {
    const requesterUserId = requireUserId(request);
    const validatedKey = validateIdempotencyKey(idempotencyKey);

    const result = await this.dunning.pauseSubscription({
      subscriptionId: id,
      requesterUserId,
      ...(body.resumesAt !== undefined && { resumesAt: new Date(body.resumesAt) }),
      ...(body.reason !== undefined && { reason: body.reason }),
      ...(validatedKey !== null && { idempotencyKey: validatedKey }),
    });
    if (!result.ok) {
      throwDunningFailure(result.error);
    }
    return result.value;
  }

  /**
   * POST /api/v1/subscriptions/:id/resume — TS-042 resume.
   *
   * Clears Stripe's `pause_collection` (empty-string Emptyable) and
   * transitions our row back to whatever status Stripe reports (typically
   * `active` or `trialing`). Pause-state columns are cleared.
   *
   * Status codes mirror `/pause` — 422 is the predominant error for an
   * already-active subscription.
   */
  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  async resume(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ResumeSubscriptionRequestSchema)) body: ResumeSubscriptionRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubscriptionResponse> {
    const requesterUserId = requireUserId(request);
    const validatedKey = validateIdempotencyKey(idempotencyKey);

    const result = await this.dunning.resumeSubscription({
      subscriptionId: id,
      requesterUserId,
      ...(body.note !== undefined && { note: body.note }),
      ...(validatedKey !== null && { idempotencyKey: validatedKey }),
    });
    if (!result.ok) {
      throwDunningFailure(result.error);
    }
    return result.value;
  }
}

/**
 * Translate a SubscriptionsFailure into the appropriate HTTP exception.
 * Always throws — the controller's call site uses the function's
 * `never` return for control flow narrowing.
 */
function throwFailure(failure: SubscriptionsFailure): never {
  switch (failure.reason) {
    case 'plan_not_found':
    case 'subscription_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail:
          failure.reason === 'plan_not_found'
            ? `plan not found: ${failure.planId}`
            : `subscription not found: ${failure.subscriptionId}`,
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
    case 'subscription_already_canceled':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `subscription is already canceled: ${failure.subscriptionId}`,
      });
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'coupon_invalid':
      // TS-043 — the create flow rejected the supplied coupon. We
      // return 400 with a `failureReason` so the family-portal can
      // render a specific message (e.g. "this code applies to a
      // different plan"). Body shape mirrors the validate endpoint
      // so the same UI branch handles both.
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `coupon ${failure.couponCode} cannot be applied: ${failure.failureReason}`,
        failureReason: failure.failureReason,
        couponCode: failure.couponCode,
      });
    case 'stripe_unavailable':
      // Generic 500 — never echo Stripe's error body to the client.
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'upstream payment provider unavailable',
      });
    case 'outbox_validation_failed':
      // TS-142-followup-9 — server-side payload validation against the
      // event registry schema failed. The transaction rolled back so no
      // orphan rows exist; the 500 + opaque body tells the client to
      // retry without exposing the registry shape externally.
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'event payload validation failed',
      });
  }
}

/**
 * Translate a DunningFailure into the appropriate HTTP exception. Always
 * throws. `invalid_state` maps to 422 (Unprocessable Entity) so the
 * client gets a distinct signal from a missing-resource 404; the body
 * lists the expected current-state set so a UI can show "this can only
 * be paused while active or past_due".
 */
function throwDunningFailure(failure: DunningFailure): never {
  switch (failure.reason) {
    case 'subscription_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `subscription not found: ${failure.subscriptionId}`,
      });
    case 'invalid_state':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `subscription state ${failure.currentStatus} not in expected set`,
        expected: failure.expected,
        currentStatus: failure.currentStatus,
      });
    case 'grace_not_expired':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `dunning grace has not yet expired (until ${failure.graceUntil.toISOString()})`,
      });
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'stripe_unavailable':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'upstream payment provider unavailable',
      });
    // TS-042-followup-3 — the lifecycle event failed registry validation and
    // the transaction rolled back, so nothing changed. A 500 rather than a
    // 4xx: the caller's request was well-formed, and the fault is a producer
    // running against a moved event contract (a deploy-skew condition an
    // operator must fix). The event name is deliberately NOT echoed — the
    // client can do nothing with it, and it is already in the error log.
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'subscription lifecycle event could not be published; no change was made',
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

/**
 * Defensive bounds on the Idempotency-Key header. Returns `null` when
 * the header is absent OR malformed (we never reject the request for a
 * malformed key — would lock out clients that disagree with our caps;
 * the safer default is to ignore the bad key and treat the request as
 * non-idempotent for our cache + still let Stripe see whatever we end
 * up generating internally).
 */
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
