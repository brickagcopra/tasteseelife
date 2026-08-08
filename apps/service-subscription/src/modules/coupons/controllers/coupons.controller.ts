import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  CreateCouponRequestSchema,
  ValidateCouponRequestSchema,
  type CreateCouponRequest,
  type ValidateCouponRequest,
  type ValidateCouponResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import { withSpan } from '@taste-and-see/tracing';
import Decimal from 'decimal.js';
import type { Response } from 'express';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  CouponMetrics,
  couponValidationOutcome,
  elapsedSeconds,
  type CouponRateLimitLabel,
  type CouponValidateOutcome,
} from '../services/coupon-metrics';
import {
  CouponRateLimitService,
  type CouponRateLimitFailure,
} from '../services/coupon-rate-limit.service';
import {
  CouponsService,
  type CouponAdminFailure,
  type CouponValidationFailure,
  type CouponPlanContext,
} from '../services/coupons.service';

/**
 * Coupon HTTP boundary (TS-043).
 *
 * Three endpoints:
 *
 *   POST   /api/v1/coupons/validate
 *     Authenticated preview of a coupon's applicability. Rate-limited
 *     per IP + per user (CLAUDE.md §12) via Redis-backed sliding window.
 *     Returns a narrow DTO that names the discount value AND the failing
 *     rule on rejection — never a generic "invalid code" — so the
 *     family-portal can surface a useful message at checkout. Today
 *     bypasses the eligibility check on the customer's prior-subscription
 *     count when the caller isn't the soft-FK owner; the row-level
 *     ownership gate lands with TS-141 tenant scoping.
 *
 *   POST   /api/v1/admin/coupons
 *     Create a coupon definition. Inherits AccessTokenGuard; the
 *     permission-level `coupon:create` gate lands once `PermissionGuard`
 *     lifts to a shared package (TS-052-followup-11). Until then the
 *     audit log + admin-MFA visibility is the trust gate.
 *
 *   DELETE /api/v1/admin/coupons/:id
 *     Deactivate. Same auth posture as create.
 *
 * **Why a single controller**: every endpoint touches the same service
 * provider stack (CouponsService, CouponRateLimitService, PrismaService)
 * and routing the admin endpoints through a separate file would
 * duplicate the auth-guard wiring. Splitting on auth scope (per-service
 * "admin" controller) is the natural next refactor once TS-127's
 * dedicated admin surface materialises.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class CouponsController {
  private readonly logger = new Logger(CouponsController.name);

  constructor(
    private readonly coupons: CouponsService,
    private readonly rateLimit: CouponRateLimitService,
    private readonly prisma: PrismaService,
    // Optional so direct `new CouponsController(...)` unit-test call sites keep
    // working; in the Nest DI graph the registered `CouponMetrics` provider is
    // injected. Instruments are no-ops until `initMetrics` runs (DunningMetrics
    // precedent).
    private readonly metrics: CouponMetrics = new CouponMetrics(),
  ) {}

  /**
   * POST /api/v1/coupons/validate — public-by-auth coupon preview.
   *
   * Authentication is required so the per-user rate-limit bucket has a
   * stable key. Unauthenticated clients couldn't drive the bucket
   * meaningfully (would all collide on the IP bucket) so the
   * AccessTokenGuard requirement is both a security and an ergonomics
   * decision.
   *
   * Status codes:
   *   200 OK            — body is the ValidateCouponResponse.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — coupon or plan not found, or coupon is not
   *                       eligible for this plan / customer (all
   *                       coupon-validation failures fold into 404 +
   *                       a `failureReason` in the body so a client
   *                       can render a specific message without
   *                       branching on more than one status code).
   *   429 Too Many      — rate-limited (Retry-After header carries the
   *                       seconds until the window rolls).
   */
  @Post('api/v1/coupons/validate')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(ValidateCouponRequestSchema))
  async validate(
    @Body() body: ValidateCouponRequest,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ValidateCouponResponse> {
    // Observability (TS-043-followup-8). The validate metric is recorded HERE
    // rather than in CouponsService because the `rate_limit` dimension is a
    // controller-only concern (the service never sees the abuse-guard
    // decision). The logical span slots a named operation between the
    // auto-instrumented HTTP request span and the Prisma children; outcome +
    // rate-limit ride the `coupon_validate_total` counter + the shared latency
    // histogram. Outcome defaults to `error` so an unexpected throw still
    // records a bounded sample.
    return withSpan('coupon.validate', async (span) => {
      const startNs = process.hrtime.bigint();
      let outcome: CouponValidateOutcome = 'error';
      let rateLimit: CouponRateLimitLabel = 'allowed';
      try {
        const requesterUserId = requireUserId(request);
        const ip = extractRequesterIp(request);

        const limit = await this.rateLimit.check({ ip, userId: requesterUserId });
        if (!limit.ok) {
          if (limit.error.reason === 'rate_limited') {
            rateLimit = 'rate_limited';
            outcome = 'rate_limited';
            throwRateLimited(limit.error, response);
          }
          // `unavailable` — Redis is down. Fail-open per CLAUDE.md §4.3
          // ("Caches are best-effort: code must work correctly when Redis
          // is unavailable"); the eligibility gate on the coupon row stays
          // authoritative.
          rateLimit = 'unavailable';
          this.logger.warn(
            { requesterUserId },
            'coupons.validate proceeding with rate-limit unavailable',
          );
        }

        const plan = await this.prisma.plan.findUnique({
          where: { id: body.planId },
          select: { id: true, currency: true, monthlyPrice: true, annualPrice: true, active: true },
        });
        if (plan === null || !plan.active) {
          outcome = 'plan_not_found';
          throw new NotFoundException({
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: `plan not found or inactive: ${body.planId}`,
            failureReason: 'plan_not_found',
          });
        }

        const planContext: CouponPlanContext = {
          id: plan.id,
          currency: plan.currency,
          monthlyPriceMinor: decimalToMinorUnits(plan.monthlyPrice),
          annualPriceMinor: decimalToMinorUnits(plan.annualPrice),
        };

        // Default to monthly for the preview — the customer hasn't picked
        // an interval yet at the validate-only surface. The actual discount
        // applied at checkout is re-computed against the chosen interval
        // inside SubscriptionsService.create.
        const result = await this.coupons.validate(
          {
            code: body.code,
            planId: body.planId,
            customerId: body.customerId,
            customerGroup: body.customerGroup,
          },
          planContext,
          'monthly',
        );
        if (!result.ok) {
          outcome = couponValidationOutcome(result.error);
          throwValidationFailure(result.error);
        }

        const validated = result.value;
        outcome = 'ok';
        this.logger.log(
          {
            couponId: validated.id,
            planId: body.planId,
            requesterUserId,
          },
          'coupons.validate ok',
        );

        return {
          couponId: validated.id,
          code: validated.code,
          name: validated.name,
          kind: validated.kind,
          duration: validated.duration,
          durationInMonths: validated.durationInMonths,
          valueAppliedMinor: validated.valueAppliedMinor,
          extendedTrialDays: validated.extendedTrialDays,
          currency: validated.currency,
        };
      } finally {
        span.setAttribute('coupon.outcome', outcome);
        span.setAttribute('coupon.rate_limit', rateLimit);
        this.metrics.recordValidate(outcome, rateLimit, elapsedSeconds(startNs));
      }
    });
  }

  /**
   * POST /api/v1/admin/coupons — create a coupon definition.
   *
   * Status codes:
   *   201 Created       — body carries `{ couponId, code }`.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not an admin role (placeholder —
   *                       row-level enforcement lands with the
   *                       permission gate; today every authenticated
   *                       caller can hit it, with the admin-MFA gate
   *                       on service-identity as the trust layer).
   *   409 Conflict      — coupon code is already taken.
   */
  @Post('api/v1/admin/coupons')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(CreateCouponRequestSchema))
  async createCoupon(
    @Body() body: CreateCouponRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<{ couponId: string; code: string }> {
    void idempotencyKey;
    const requesterUserId = requireUserId(request);

    const result = await this.coupons.createCoupon(body, requesterUserId);
    if (!result.ok) {
      throwAdminFailure(result.error);
    }

    this.logger.log(
      { couponId: result.value.couponId, code: result.value.code, requesterUserId },
      'coupons.admin.createCoupon ok',
    );

    return result.value;
  }

  /**
   * DELETE /api/v1/admin/coupons/:id — deactivate a coupon.
   *
   * Idempotent — repeat calls against an already-inactive row return
   * 204 No Content without touching the DB.
   *
   * Status codes:
   *   204 No Content    — coupon deactivated (or was already inactive).
   *   401 Unauthorized  — missing / invalid access token.
   *   404 Not Found     — coupon does not exist.
   */
  @Delete('api/v1/admin/coupons/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Idempotent()
  async deactivateCoupon(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<void> {
    void idempotencyKey;
    const requesterUserId = requireUserId(request);

    const result = await this.coupons.deactivateCoupon(id);
    if (!result.ok) {
      throwAdminFailure(result.error);
    }

    this.logger.log({ couponId: id, requesterUserId }, 'coupons.admin.deactivateCoupon ok');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Translate a CouponValidationFailure into the appropriate HTTP
 * exception. The body carries `failureReason` so the client can
 * render a specific message without parsing the prose `detail`.
 */
function throwValidationFailure(failure: CouponValidationFailure): never {
  const baseBody = (
    detail: string,
  ): {
    readonly type: 'about:blank';
    readonly title: 'Not Found';
    readonly status: 404;
    readonly detail: string;
    readonly failureReason: string;
  } => ({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail,
    failureReason: failure.reason,
  });

  switch (failure.reason) {
    case 'coupon_not_found':
      throw new NotFoundException(baseBody(`coupon not found: ${failure.code}`));
    case 'coupon_inactive':
      throw new NotFoundException(baseBody(`coupon inactive: ${failure.couponId}`));
    case 'coupon_expired':
      throw new NotFoundException(baseBody(`coupon expired: ${failure.expiresAt.toISOString()}`));
    case 'coupon_cap_reached':
      throw new NotFoundException(
        baseBody(`coupon redemption cap reached: ${failure.maxRedemptions}`),
      );
    case 'coupon_plan_not_eligible':
      throw new NotFoundException(baseBody(`coupon does not apply to plan ${failure.planId}`));
    case 'coupon_min_spend_not_met':
      throw new NotFoundException(
        baseBody(
          `coupon requires plan price ≥ ${failure.minSpendMinor} minor; plan is ${failure.unitPriceMinor}`,
        ),
      );
    case 'coupon_per_customer_limit_reached':
      throw new NotFoundException(
        baseBody(`per-customer limit reached (limit=${failure.perCustomerLimit})`),
      );
    case 'coupon_first_time_only':
      throw new NotFoundException(
        baseBody(
          `coupon is first-time-only; customer has ${failure.priorSubscriptions} prior subs`,
        ),
      );
  }
}

function throwAdminFailure(failure: CouponAdminFailure): never {
  switch (failure.reason) {
    case 'coupon_code_taken':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `coupon code already exists: ${failure.code}`,
      });
    case 'coupon_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `coupon not found: ${failure.couponId}`,
      });
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
  }
}

/**
 * Throw a 429 with `Retry-After` set to the remaining window seconds.
 * NestJS doesn't ship a `TooManyRequestsException` so we use the base
 * `HttpException` with the explicit status code.
 */
function throwRateLimited(
  failure: Extract<CouponRateLimitFailure, { reason: 'rate_limited' }>,
  response: Response,
): never {
  response.setHeader('Retry-After', String(failure.retryAfterSeconds));
  throw new HttpException(
    {
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      detail: `coupon validate rate-limit (${failure.scope}) exceeded; retry after ${failure.retryAfterSeconds}s`,
      scope: failure.scope,
      retryAfterSeconds: failure.retryAfterSeconds,
      limit: failure.limit,
      windowSeconds: failure.windowSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
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
 * Read the source IP from the request, preferring the X-Forwarded-For
 * left-most entry when the deployment fronts the service with a trusted
 * proxy. Falls back to `request.ip` (express handles X-Forwarded-For if
 * the trust-proxy setting is on). Returns 'unknown' as a last resort so
 * the rate-limiter bucket key is always non-empty.
 */
function extractRequesterIp(request: RequestWithContext): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0]?.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  if (typeof request.ip === 'string' && request.ip.length > 0) return request.ip;
  return 'unknown';
}

/**
 * Convert a Prisma Decimal column (DECIMAL(12,2)) to integer minor
 * units. Mirrors the helper in SubscriptionsService — duplicated here
 * to keep the module's surface self-contained. Lifts to a shared
 * helper once a third consumer arrives.
 */
function decimalToMinorUnits(value: Decimal): number {
  return value
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
    .mul(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
    .toNumber();
}
