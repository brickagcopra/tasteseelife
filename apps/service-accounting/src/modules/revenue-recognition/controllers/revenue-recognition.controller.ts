import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  ConflictException,
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
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  CancelDeferredRevenueRequestSchema,
  RecognizeActivationRequestSchema,
  RecognizeDailyRequestSchema,
  type CancelDeferredRevenueRequest,
  type CancelDeferredRevenueResponse,
  type RecognizeActivationRequest,
  type RecognizeActivationResponse,
  type RecognizeDailyReport,
  type RecognizeDailyRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import {
  SubscriptionRevenueRecognizerService,
  type CancelDeferredRevenueFailure,
  type CancelDeferredRevenueOutput,
  type RecognizeActivationFailure,
  type RecognizeActivationOutput,
} from '../services/subscription-revenue-recognizer.service';

/**
 * Shared header carrying the internal-dispatch shared secret. Reuses
 * `INTERNAL_POST_JOURNAL_API_KEY` from TS-081 — the relay (post-TS-142)
 * is the single trust principal for all `/api/v1/internal/*` endpoints
 * on the accounting service, so a single secret matches the
 * separation-of-concerns the same way `KYC_WEBHOOK_INTERNAL_API_KEY`
 * covers every internal endpoint on service-identity. A future
 * consolidation follow-up captures the rename if more granularity is
 * needed.
 */
export const RECOGNITION_INTERNAL_API_KEY_HEADER = 'x-accounting-internal-api-key';

/**
 * `RevenueRecognitionController` — write surfaces for the subscription
 * revenue recognition driver (TS-082, PDD §11.2, Appendix A,
 * CLAUDE.md §17.17).
 *
 *   - `POST /api/v1/internal/subscription/activated` — called by the
 *     outbox relay (TS-142; synchronous HTTP scaffold pre-relay used
 *     by service-subscription). Shared-secret pinned. Posts the
 *     activation journal AND creates the balance row in one
 *     transaction; idempotent on `sourceEventId`.
 *
 *   - `POST /api/v1/internal/subscription/canceled` — system-driven
 *     halt of recognition. Same shared-secret pin. Idempotent.
 *
 *   - `POST /api/v1/admin/subscription/recognize-daily` — admin
 *     trigger for the daily sweep. AccessTokenGuard. The BullMQ
 *     scheduled worker landing under TS-142 follow-ups will call the
 *     same service method directly (no HTTP hop).
 *
 * Every write endpoint carries `@Idempotent()` so a client retry
 * against the same `Idempotency-Key` header replays the cached
 * response (CLAUDE.md §3.3). The service-layer idempotency on
 * `sourceEventId` is the second line of defence.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The two
 * shared-secret-pinned internal endpoints (`recognizeActivation` and
 * `cancelDeferredRevenue`) authenticate via the
 * `RECOGNITION_INTERNAL_API_KEY_HEADER` rather than the
 * `AccessTokenGuard`, so the `TenantContextInterceptor` cannot seed a
 * scoped frame from a `request.requestContext` that does not exist.
 * Both handler bodies wrap in `runWithoutTenantContext(...,
 * 'internal-subscription-activated' | 'internal-subscription-canceled',
 * ...)` so every Prisma operation downstream sees an explicit `exempt`
 * frame rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. Mirrors the
 * `AuditController.recordEvent` wrap landed under
 * TS-020-followup-2b-platform-rollout-svc-audit.
 *
 * The admin endpoint (`recognizeDaily`) sits behind `AccessTokenGuard`
 * so the `TenantContextInterceptor` seeds a scoped frame from the
 * access-token claims before the handler body runs — no wrap needed.
 */
@Controller()
export class RevenueRecognitionController {
  private readonly logger = new Logger(RevenueRecognitionController.name);

  constructor(
    private readonly recognizer: SubscriptionRevenueRecognizerService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {}

  /**
   * System-driven activation post. The relay sends the same
   * `sourceEventId` that lands on the activation journal; a
   * redelivery returns the previously-created balance + journal.
   */
  @Post('api/v1/internal/subscription/activated')
  @HttpCode(HttpStatus.CREATED)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(RecognizeActivationRequestSchema))
  async recognizeActivation(
    @Body() body: RecognizeActivationRequest,
    @Req() request: Request,
  ): Promise<RecognizeActivationResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-subscription-activated',
      async () => {
        this.requireInternalSharedSecret(request);
        const result = await this.recognizer.recognizeActivation(body);
        if (result.ok) {
          return toActivationResponse(result.value);
        }
        throw mapActivationFailureToHttp(result.failure);
      },
    );
  }

  /**
   * System-driven halt of recognition.
   */
  @Post('api/v1/internal/subscription/canceled')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(CancelDeferredRevenueRequestSchema))
  async cancelDeferredRevenue(
    @Body() body: CancelDeferredRevenueRequest,
    @Req() request: Request,
  ): Promise<CancelDeferredRevenueResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-subscription-canceled', async () => {
      this.requireInternalSharedSecret(request);
      const result = await this.recognizer.cancelDeferredRevenue(body);
      if (result.ok) {
        return toCancelResponse(result.value);
      }
      throw mapCancelFailureToHttp(result.failure);
    });
  }

  /**
   * Admin-driven daily sweep. The endpoint lives on the admin surface
   * (not `/internal`) because operators legitimately need to trigger
   * back-fills + same-day re-runs; the scheduled BullMQ worker
   * (TS-082-followup-2) calls the service method directly.
   */
  @Post('api/v1/admin/subscription/recognize-daily')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(RecognizeDailyRequestSchema))
  async recognizeDaily(
    @Body() body: RecognizeDailyRequest,
    @Req() request: RequestWithContext,
  ): Promise<RecognizeDailyReport> {
    const actorId = requireActor(request);
    const asOf = body.asOf !== undefined ? new Date(body.asOf) : new Date();
    const report = await this.recognizer.recognizeDaily(asOf);
    this.logger.warn(
      {
        actorId,
        asOf: report.asOf.toISOString(),
        scannedCount: report.scannedCount,
        recognizedCount: report.recognizedCount,
        completedCount: report.completedCount,
        failedCount: report.failedCount,
        totalRecognizedMinor: report.totalRecognizedMinor,
      },
      'revenue-recognition.daily.admin-triggered',
    );
    return {
      asOf: report.asOf.toISOString(),
      scannedCount: report.scannedCount,
      recognizedCount: report.recognizedCount,
      skippedCount: report.skippedCount,
      completedCount: report.completedCount,
      failedCount: report.failedCount,
      totalRecognizedMinor: report.totalRecognizedMinor,
    };
  }

  private requireInternalSharedSecret(request: Request): void {
    const presented = request.header(RECOGNITION_INTERNAL_API_KEY_HEADER);
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

function toActivationResponse(output: RecognizeActivationOutput): RecognizeActivationResponse {
  return {
    balanceId: output.balanceId,
    subscriptionId: output.subscriptionId,
    activationJournalId: output.activationJournalId,
    originalAmountMinor: output.originalAmountMinor,
    recognizedAmountMinor: output.recognizedAmountMinor,
    currency: output.currency,
    servicePeriodStart: output.servicePeriodStart.toISOString(),
    servicePeriodEnd: output.servicePeriodEnd.toISOString(),
    status: output.status,
    result: output.result,
  };
}

function toCancelResponse(output: CancelDeferredRevenueOutput): CancelDeferredRevenueResponse {
  return {
    balanceId: output.balanceId,
    subscriptionId: output.subscriptionId,
    previousStatus: output.previousStatus,
    status: output.status,
    remainingDeferredMinor: output.remainingDeferredMinor,
    result: output.result,
  };
}

function mapActivationFailureToHttp(failure: RecognizeActivationFailure): never {
  switch (failure.kind) {
    case 'period_inverted':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'servicePeriodStart must be strictly before servicePeriodEnd.',
        failureReason: failure.kind,
      });
    case 'amount_non_positive':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'amountMinor must be a positive integer.',
        failureReason: failure.kind,
      });
    case 'subscription_period_conflict':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'A balance already exists for this (subscription, servicePeriodStart) under a different sourceEventId.',
        failureReason: failure.kind,
        subscriptionId: failure.subscriptionId,
        servicePeriodStart: failure.servicePeriodStart,
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
            detail: 'Activation journal was unbalanced — internal error.',
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

function mapCancelFailureToHttp(failure: CancelDeferredRevenueFailure): never {
  switch (failure.kind) {
    case 'balance_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No deferred-revenue balance found for the given subscription period.',
        failureReason: failure.kind,
        subscriptionId: failure.subscriptionId,
        servicePeriodStart: failure.servicePeriodStart,
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
