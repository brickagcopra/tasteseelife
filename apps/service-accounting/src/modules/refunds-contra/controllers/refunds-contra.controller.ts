import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UsePipes,
} from '@nestjs/common';
import {
  ApplyBookingRefundRequestSchema,
  ApplyCouponRedemptionRequestSchema,
  ApplySubscriptionRefundRequestSchema,
  type ApplyBookingRefundRequest,
  type ApplyBookingRefundResponse,
  type ApplyCouponRedemptionRequest,
  type ApplyCouponRedemptionResponse,
  type ApplySubscriptionRefundRequest,
  type ApplySubscriptionRefundResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import {
  CouponContraRevenueService,
  type ApplyCouponRedemptionFailure,
  type ApplyCouponRedemptionOutput,
} from '../services/coupon-contra-revenue.service';
import {
  RefundService,
  type ApplyBookingRefundFailure,
  type ApplyBookingRefundOutput,
  type ApplySubscriptionRefundFailure,
  type ApplySubscriptionRefundOutput,
} from '../services/refund.service';

/**
 * Shared header for the internal-dispatch shared secret. Reuses
 * `INTERNAL_POST_JOURNAL_API_KEY` from TS-081 — the relay (post-TS-142)
 * is the single trust principal for all `/api/v1/internal/*` endpoints
 * on the accounting service, so a single secret matches the
 * separation-of-concerns the same way `KYC_WEBHOOK_INTERNAL_API_KEY`
 * covers every internal endpoint on service-identity. Mirrors the
 * convention from RevenueRecognitionController + BookingCommissionController.
 */
export const REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER = 'x-accounting-internal-api-key';

/**
 * `RefundsContraController` — write surfaces for the three TS-084 flows
 * (PDD §11.2, Appendix A, CLAUDE.md §6):
 *
 *   - `POST /api/v1/internal/coupon/redeemed` — called by the outbox
 *     relay (TS-142; synchronous HTTP scaffold pre-relay called by
 *     service-subscription's coupon module after a redemption lands).
 *     Shared-secret pinned. Posts the two-line contra-revenue journal;
 *     idempotent on `sourceEventId`. Closes TS-043-followup-11.
 *
 *   - `POST /api/v1/internal/subscription/refunded` — system-driven
 *     subscription refund. Posts the literal PDD Appendix A entry
 *     (`DR 4000.{planCode} / CR 1000`). Closes TS-082-followup-9 at
 *     the journal layer; the deferred-revenue cleanup nuance is
 *     captured as a separate TS-084-followup.
 *
 *   - `POST /api/v1/internal/booking/refunded` — system-driven booking
 *     refund with provider clawback. Posts the two-leg reversal AND
 *     decrements the per-provider running balance (may go negative
 *     under clawback). Closes TS-083-followup-10.
 *
 * Every write endpoint carries `@Idempotent()` so a client retry
 * against the same `Idempotency-Key` header replays the cached
 * response (CLAUDE.md §3.3). The service-layer idempotency on
 * `sourceEventId` is the second line of defence at the journal layer.
 *
 * All three endpoints share the same shared-secret pin so the relay
 * holds one secret across the whole accounting receiver surface.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). All three
 * shared-secret-pinned internal endpoints (`applyCouponRedemption`,
 * `applySubscriptionRefund`, `applyBookingRefund`) authenticate via the
 * `REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER` rather than the
 * `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed a
 * scoped frame from a `request.requestContext` that does not exist.
 * Each handler body wraps in `runWithoutTenantContext(...,
 * 'internal-coupon-redeemed' | 'internal-subscription-refunded' |
 * 'internal-booking-refunded', ...)` so every Prisma operation
 * downstream (the contra-revenue journal insert, the per-provider
 * running balance clawback decrement) sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 */
@Controller()
export class RefundsContraController {
  private readonly logger = new Logger(RefundsContraController.name);

  constructor(
    private readonly coupon: CouponContraRevenueService,
    private readonly refund: RefundService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  // ── Coupon contra-revenue ────────────────────────────────────────────

  @Post('api/v1/internal/coupon/redeemed')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ApplyCouponRedemptionRequestSchema))
  async applyCouponRedemption(
    @Body() body: ApplyCouponRedemptionRequest,
    @Req() request: Request,
  ): Promise<ApplyCouponRedemptionResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-coupon-redeemed', async () => {
      this.requireInternalSharedSecret(request);
      const result = await this.coupon.applyCouponRedemption(body);
      if (result.ok) {
        return toCouponResponse(result.value);
      }
      throw mapCouponFailureToHttp(result.failure);
    });
  }

  // ── Subscription refund ──────────────────────────────────────────────

  @Post('api/v1/internal/subscription/refunded')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ApplySubscriptionRefundRequestSchema))
  async applySubscriptionRefund(
    @Body() body: ApplySubscriptionRefundRequest,
    @Req() request: Request,
  ): Promise<ApplySubscriptionRefundResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-subscription-refunded', async () => {
      this.requireInternalSharedSecret(request);
      const result = await this.refund.applySubscriptionRefund(body);
      if (result.ok) {
        return toSubscriptionRefundResponse(result.value);
      }
      throw mapSubscriptionRefundFailureToHttp(result.failure);
    });
  }

  // ── Booking refund ───────────────────────────────────────────────────

  @Post('api/v1/internal/booking/refunded')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(ApplyBookingRefundRequestSchema))
  async applyBookingRefund(
    @Body() body: ApplyBookingRefundRequest,
    @Req() request: Request,
  ): Promise<ApplyBookingRefundResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-booking-refunded', async () => {
      this.requireInternalSharedSecret(request);
      const result = await this.refund.applyBookingRefund(body);
      if (result.ok) {
        return toBookingRefundResponse(result.value);
      }
      throw mapBookingRefundFailureToHttp(result.failure);
    });
  }

  // ── Shared helpers ───────────────────────────────────────────────────

  private requireInternalSharedSecret(request: Request): void {
    const presented = request.header(REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER);
    if (!isSharedSecretValid(presented, this.env.INTERNAL_POST_JOURNAL_API_KEY)) {
      this.logger.warn(
        { header: REFUNDS_CONTRA_INTERNAL_API_KEY_HEADER },
        'refunds-contra.internal.unauthorized',
      );
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Internal dispatch authentication failed.',
      });
    }
  }
}

// ── Response mappers ──────────────────────────────────────────────────────

function toCouponResponse(output: ApplyCouponRedemptionOutput): ApplyCouponRedemptionResponse {
  return {
    journalId: output.journalId,
    couponRedemptionId: output.couponRedemptionId,
    subscriptionId: output.subscriptionId,
    planCode: output.planCode,
    discountAmountMinor: output.discountAmountMinor,
    currency: output.currency,
    result: output.result,
  };
}

function toSubscriptionRefundResponse(
  output: ApplySubscriptionRefundOutput,
): ApplySubscriptionRefundResponse {
  return {
    journalId: output.journalId,
    subscriptionId: output.subscriptionId,
    planCode: output.planCode,
    refundAmountMinor: output.refundAmountMinor,
    currency: output.currency,
    result: output.result,
  };
}

function toBookingRefundResponse(output: ApplyBookingRefundOutput): ApplyBookingRefundResponse {
  return {
    journalId: output.journalId,
    bookingId: output.bookingId,
    providerId: output.providerId,
    refundAmountMinor: output.refundAmountMinor,
    providerPortionMinor: output.providerPortionMinor,
    marketplacePortionMinor: output.marketplacePortionMinor,
    commissionRateBps: output.commissionRateBps,
    currency: output.currency,
    runningPayableMinor: output.runningPayableMinor,
    result: output.result,
  };
}

// ── Failure-to-HTTP mapping ───────────────────────────────────────────────

function mapCouponFailureToHttp(failure: ApplyCouponRedemptionFailure): never {
  switch (failure.kind) {
    case 'amount_non_positive':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'discountAmountMinor must be a positive integer.',
        failureReason: failure.kind,
      });
    case 'journal_post_failed':
      mapJournalPostFailure(failure.failure, 'Coupon contra-revenue');
  }
}

function mapSubscriptionRefundFailureToHttp(failure: ApplySubscriptionRefundFailure): never {
  switch (failure.kind) {
    case 'amount_non_positive':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'refundAmountMinor must be a positive integer.',
        failureReason: failure.kind,
      });
    case 'journal_post_failed':
      mapJournalPostFailure(failure.failure, 'Subscription refund');
  }
}

function mapBookingRefundFailureToHttp(failure: ApplyBookingRefundFailure): never {
  switch (failure.kind) {
    case 'amount_invariant_violated':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail:
          'refundAmount must equal providerPortion + marketplacePortion; the reversal legs cannot balance otherwise.',
        failureReason: failure.kind,
      });
    case 'amount_non_positive':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'refundAmountMinor must be a positive integer.',
        failureReason: failure.kind,
      });
    case 'journal_post_failed':
      mapJournalPostFailure(failure.failure, 'Booking refund');
  }
}

/**
 * Shared journal-post failure mapper. Mirrors the per-controller
 * mappers across service-accounting (RevenueRecognitionController,
 * BookingCommissionController) so the failure-to-HTTP shape stays
 * consistent across every receiver.
 */
function mapJournalPostFailure(
  failure: import('../../journals/services/journal-posting.service').PostJournalFailure,
  context: string,
): never {
  switch (failure.kind) {
    case 'account_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Chart-of-accounts entry not found for code "${failure.accountCode}".`,
        failureReason: 'account_not_found',
        accountCode: failure.accountCode,
      });
    case 'account_inactive':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Chart-of-accounts entry "${failure.accountCode}" is inactive.`,
        failureReason: 'account_inactive',
        accountCode: failure.accountCode,
      });
    case 'journal_unbalanced':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `${context} journal was unbalanced — internal error.`,
        failureReason: 'journal_unbalanced',
        debitTotalMinor: failure.debitTotalMinor,
        creditTotalMinor: failure.creditTotalMinor,
      });
    case 'mixed_currency':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Mixed-currency journal rejected.',
        failureReason: 'mixed_currency',
        currencies: failure.currencies,
      });
    case 'period_closed':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Accounting period ${failure.periodName} is closed.`,
        failureReason: 'period_closed',
        periodId: failure.periodId,
        periodName: failure.periodName,
      });
  }
}

function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
