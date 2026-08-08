import { Module } from '@nestjs/common';

import { ConnectModule } from '../connect/connect.module';

import { DisbursementsController } from './controllers/disbursements.controller';
import { MeDisbursementsController } from './controllers/me-disbursements.controller';
import { TransferEventsController } from './controllers/transfer-events.controller';
import { DisbursementSchedulerService } from './services/disbursement-scheduler.service';
import { DisbursementsService } from './services/disbursements.service';
import { PayableBalanceProvider } from './services/payable-balance.provider';
import { StripeTransfersService } from './services/stripe-transfers.service';

/**
 * Disbursements module (TS-091).
 *
 *   - StripeTransfersService — thin Stripe SDK wrapper (stub in Phase 1).
 *   - DisbursementsService   — schedule + execute + apply-transfer-event
 *     state machine; persistence + idempotency.
 *   - DisbursementSchedulerService — daily sweep orchestrator; reads
 *     balances from PayableBalanceProvider, applies gates, calls
 *     DisbursementsService.scheduleDisbursement per qualifying provider.
 *   - PayableBalanceProvider — Phase 1 stub-mode in-memory cache;
 *     TS-091-followup-2 swaps in the live HTTP client.
 *
 *   - DisbursementsController (admin) — sweep trigger + manual
 *     scheduling + execute / cancel + list / get-by-id.
 *   - MeDisbursementsController (provider self-service) — read MY
 *     disbursement history.
 *   - TransferEventsController (internal) — Stripe `transfer.paid` /
 *     `transfer.failed` ingest, shared-secret pinned.
 *
 * Imports `ConnectModule` so the scheduler + the schedule path can
 * reach `PayoutAccountsService` to check the destination account's
 * `status === 'active'` gate.
 *
 * `PayableBalanceProvider` exported so admin tooling can later seed
 * balances directly (Phase 1) or wrap a different transport (Phase 2+).
 *
 * `AccessTokenGuard` is auto-provided globally by `NestAuthModule`
 * (TS-052-followup-11a) — no need to list it in this module's
 * `providers` array.
 */
@Module({
  imports: [ConnectModule],
  controllers: [DisbursementsController, MeDisbursementsController, TransferEventsController],
  providers: [
    DisbursementsService,
    DisbursementSchedulerService,
    StripeTransfersService,
    PayableBalanceProvider,
  ],
  exports: [DisbursementsService, PayableBalanceProvider],
})
export class DisbursementsModule {}
