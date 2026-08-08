import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common';
import {
  type IngestPayoutTransferEventRequest,
  IngestPayoutTransferEventRequestSchema,
  type IngestPayoutTransferEventResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

import { toIngestPayoutTransferEventResponse } from '../mappers/disbursement.mapper';
import { DisbursementsService } from '../services/disbursements.service';

/**
 * Internal Stripe transfer-event ingest (TS-091).
 *
 *   POST /api/v1/internal/payouts/transfer-events
 *
 * Shared-secret pinned via `PAYOUT_TRANSFERS_HEADER_NAME` /
 * `PAYOUT_TRANSFERS_API_KEY` (constant-time `timingSafeEqual`). Mirrors
 * the TS-090 `stripe-account-events` ingest shape.
 *
 * service-webhook (TS-041a) verifies Stripe's webhook signature,
 * persists the raw `transfer.paid` / `transfer.failed` event in
 * `stripe_processed_events`, then forwards the down-projected payload
 * here. service-payouts owns the application-side state flip.
 *
 * Idempotent on the (stripeTransferId, outcome) pair:
 *   - first delivery of `paid` → status 'paid' (`applied`).
 *   - retry of `paid` against an already-paid row → `replayed`.
 *   - event for an unknown stripeTransferId → `ignored`.
 *
 * Failure mapping:
 *   401 — missing / wrong shared-secret header.
 *   400 — Zod validation failure (the contract enforces failureReason
 *         when outcome=failed).
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). This endpoint
 * authenticates via the `PAYOUT_TRANSFERS_HEADER_NAME` shared secret
 * rather than the `AccessTokenGuard`, so the `TenantContextInterceptor`
 * cannot seed a scoped frame from a `request.requestContext` that does
 * not exist. The handler body wraps in `runWithoutTenantContext(...,
 * 'internal-payout-transfer-event', ...)` so every Prisma operation
 * downstream (the disbursement row state flip + future accounting
 * postback under TS-083-followup-9) sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 */
@Controller()
export class TransferEventsController {
  private readonly internalApiKey: string;
  private readonly internalHeaderName: string;

  constructor(
    private readonly disbursements: DisbursementsService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.PAYOUT_TRANSFERS_API_KEY;
    this.internalHeaderName = env.PAYOUT_TRANSFERS_HEADER_NAME;
  }

  @Post('api/v1/internal/payouts/transfer-events')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(IngestPayoutTransferEventRequestSchema))
  async ingest(
    @Body() body: IngestPayoutTransferEventRequest,
    @Req() request: Request,
  ): Promise<IngestPayoutTransferEventResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-payout-transfer-event', async () => {
      const presented = request.header(this.internalHeaderName);
      if (!isSharedSecretValid(presented, this.internalApiKey)) {
        throw new UnauthorizedException({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Internal transfer-events authentication failed.',
        });
      }

      const applyInput: {
        stripeTransferId: string;
        outcome: 'paid' | 'failed';
        occurredAt: Date;
        failureReason?: string;
      } = {
        stripeTransferId: body.stripeTransferId,
        outcome: body.outcome,
        occurredAt: new Date(body.occurredAt),
      };
      if (body.failureReason !== undefined) applyInput.failureReason = body.failureReason;

      const result = await this.disbursements.applyTransferEvent(applyInput);
      return toIngestPayoutTransferEventResponse(result.outcome, result.disbursement);
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
