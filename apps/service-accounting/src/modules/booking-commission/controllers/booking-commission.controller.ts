import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
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
  BookingCommissionRequestSchema,
  type BookingCommissionRequest,
  type BookingCommissionResponse,
  type ProviderPayableBalanceResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
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
  BookingCommissionRecognizerService,
  type RecognizeBookingCompletionFailure,
  type RecognizeBookingCompletionOutput,
} from '../services/booking-commission-recognizer.service';

/**
 * Shared header for the internal-dispatch shared secret. Reuses
 * `INTERNAL_POST_JOURNAL_API_KEY` from TS-081 — the relay (post-TS-142)
 * is the single trust principal for all `/api/v1/internal/*` endpoints
 * on the accounting service, so a single secret matches the
 * separation-of-concerns the same way `KYC_WEBHOOK_INTERNAL_API_KEY`
 * covers every internal endpoint on service-identity. Mirrors the
 * convention from RevenueRecognitionController (TS-082).
 */
export const BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER = 'x-accounting-internal-api-key';

/**
 * `BookingCommissionController` — write + read surfaces for the booking-
 * completion journal + per-provider payable balance (TS-083, PDD §9.2,
 * Appendix A).
 *
 *   - `POST /api/v1/internal/booking/completed` — called by the outbox
 *     relay (TS-142; synchronous HTTP scaffold pre-relay used by
 *     service-booking once TS-060 ships). Shared-secret pinned. Posts
 *     the four-line booking-completion journal AND upserts the per-
 *     provider running balance in one orchestrated flow; idempotent
 *     on `sourceEventId`.
 *
 *   - `GET /api/v1/admin/providers/:providerId/payable-balance` —
 *     finance / ops read of the provider's outstanding payable.
 *     `AccessTokenGuard` enforces authentication; row-level permission
 *     gating arrives via TS-052-followup-11's `PermissionGuard` lift
 *     (target permission: `payouts:read`).
 *
 * Every write endpoint carries `@Idempotent()` so a client retry
 * against the same `Idempotency-Key` header replays the cached
 * response (CLAUDE.md §3.3). The service-layer idempotency on
 * `sourceEventId` is the second line of defence.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The
 * shared-secret-pinned internal endpoint (`recognizeBookingCompleted`)
 * authenticates via the `BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER`
 * rather than the `AccessTokenGuard`, so the `TenantContextInterceptor`
 * cannot seed a scoped frame from a `request.requestContext` that does
 * not exist. The handler body wraps in `runWithoutTenantContext(...,
 * 'internal-booking-completed', ...)` so every Prisma operation
 * downstream (the four-line journal insert + the per-provider running
 * balance upsert) sees an explicit `exempt` frame rather than failing
 * with `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`.
 *
 * The admin endpoint (`getProviderPayableBalance`) sits behind
 * `AccessTokenGuard` so the `TenantContextInterceptor` seeds a scoped
 * frame from the access-token claims — no wrap needed.
 */
@Controller()
export class BookingCommissionController {
  private readonly logger = new Logger(BookingCommissionController.name);

  constructor(
    private readonly recognizer: BookingCommissionRecognizerService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * System-driven booking-completion post. The relay sends the same
   * `sourceEventId` that lands on the journal; a redelivery returns
   * the previously-posted journal id + the unchanged running balance.
   */
  @Post('api/v1/internal/booking/completed')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(BookingCommissionRequestSchema))
  async recognizeBookingCompleted(
    @Body() body: BookingCommissionRequest,
    @Req() request: Request,
  ): Promise<BookingCommissionResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-booking-completed', async () => {
      this.requireInternalSharedSecret(request);
      const result = await this.recognizer.recognizeBookingCompleted(body);
      if (result.ok) {
        return toBookingCommissionResponse(result.value);
      }
      throw mapBookingCommissionFailureToHttp(result.failure);
    });
  }

  /**
   * Admin read of a provider's outstanding payable balance. Returns
   * 404 when no booking has been completed for the provider yet
   * (the row doesn't exist) — the caller can choose to render "no
   * payable" or treat the absence as zero.
   */
  @Get('api/v1/admin/providers/:providerId/payable-balance')
  @UseGuards(AccessTokenGuard)
  async getProviderPayableBalance(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<ProviderPayableBalanceResponse> {
    requireActor(request);
    if (providerId.length === 0 || providerId.length > 64) {
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'providerId is required and must be at most 64 characters.',
        failureReason: 'malformed_provider_id',
      });
    }

    const row = await this.recognizer.getProviderPayableBalance(providerId, 'USD');
    if (row === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No payable balance row exists for this provider yet.',
        failureReason: 'payable_balance_not_found',
        providerId,
      });
    }

    this.logger.log(
      {
        providerId: row.providerId,
        amountMinor: row.amountMinor,
        currency: row.currency,
      },
      'booking-commission.payable-balance.read',
    );
    return {
      providerId: row.providerId,
      currency: row.currency,
      amountMinor: row.amountMinor,
      lastUpdatedAt: row.lastUpdatedAt.toISOString(),
    };
  }

  private requireInternalSharedSecret(request: Request): void {
    const presented = request.header(BOOKING_COMMISSION_INTERNAL_API_KEY_HEADER);
    if (!isSharedSecretValid(presented, this.env.INTERNAL_POST_JOURNAL_API_KEY)) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Internal dispatch authentication failed.',
      });
    }
  }
}

function requireActor(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined || ctx.userId === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function toBookingCommissionResponse(
  output: RecognizeBookingCompletionOutput,
): BookingCommissionResponse {
  return {
    journalId: output.journalId,
    bookingId: output.bookingId,
    providerId: output.providerId,
    grossAmountMinor: output.grossAmountMinor,
    providerAmountMinor: output.providerAmountMinor,
    marketplaceAmountMinor: output.marketplaceAmountMinor,
    commissionRateBps: output.commissionRateBps,
    currency: output.currency,
    runningPayableMinor: output.runningPayableMinor,
    result: output.result,
  };
}

function mapBookingCommissionFailureToHttp(failure: RecognizeBookingCompletionFailure): never {
  switch (failure.kind) {
    case 'amount_invariant_violated':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail:
          'gross must equal provider + marketplace; the four-line journal cannot balance otherwise.',
        failureReason: failure.kind,
      });
    case 'amount_non_positive':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'grossAmountMinor must be a positive integer.',
        failureReason: failure.kind,
      });
    case 'journal_post_failed': {
      const inner = failure.failure;
      switch (inner.kind) {
        case 'account_not_found':
          throw new NotFoundException({
            type: 'about:blank',
            title: 'Not Found',
            status: 404,
            detail: `Chart-of-accounts entry not found for code "${inner.accountCode}".`,
            failureReason: 'account_not_found',
            accountCode: inner.accountCode,
          });
        case 'account_inactive':
          throw new UnprocessableEntityException({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: `Chart-of-accounts entry "${inner.accountCode}" is inactive.`,
            failureReason: 'account_inactive',
            accountCode: inner.accountCode,
          });
        case 'journal_unbalanced':
          throw new UnprocessableEntityException({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: 'Booking-completion journal was unbalanced — internal error.',
            failureReason: 'journal_unbalanced',
            debitTotalMinor: inner.debitTotalMinor,
            creditTotalMinor: inner.creditTotalMinor,
          });
        case 'mixed_currency':
          throw new UnprocessableEntityException({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: 'Mixed-currency journal rejected.',
            failureReason: 'mixed_currency',
            currencies: inner.currencies,
          });
        case 'period_closed':
          throw new UnprocessableEntityException({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: 422,
            detail: `Accounting period ${inner.periodName} is closed.`,
            failureReason: 'period_closed',
            periodId: inner.periodId,
            periodName: inner.periodName,
          });
      }
    }
  }
}

function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
