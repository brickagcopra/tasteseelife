import { Module } from '@nestjs/common';

import { ConnectController } from './controllers/connect.controller';
import { StripeEventsController } from './controllers/stripe-events.controller';
import { PayoutAccountsService } from './services/payout-accounts.service';
import { StripeAccountEventsService } from './services/stripe-account-events.service';
import { StripeConnectService } from './services/stripe-connect.service';

/**
 * Connect module — Stripe Connect Express onboarding surface (TS-090).
 *
 *   - StripeConnectService: thin Stripe SDK wrapper (stub in Phase 1).
 *   - PayoutAccountsService: persistence + status derivation +
 *     idempotent create-or-fetch + onboarding-link issuance.
 *   - StripeAccountEventsService: idempotent ingest of `account.updated`.
 *   - ConnectController: provider self-service + admin read endpoints.
 *   - StripeEventsController: shared-secret-pinned internal ingest.
 *
 * Exports `PayoutAccountsService` so the future TS-091 disbursement
 * scheduler module can read provider account state in-process.
 *
 * `AccessTokenGuard` is auto-provided globally by `NestAuthModule`
 * (TS-052-followup-11a) — no need to list it in this module's
 * `providers` array.
 */
@Module({
  controllers: [ConnectController, StripeEventsController],
  providers: [StripeConnectService, PayoutAccountsService, StripeAccountEventsService],
  exports: [PayoutAccountsService],
})
export class ConnectModule {}
