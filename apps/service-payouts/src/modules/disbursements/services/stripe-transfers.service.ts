import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { isStripeStubMode } from '../../../config/env';

/**
 * Thin Stripe Transfer SDK wrapper (TS-091; sibling of the
 * `StripeConnectService` shape from TS-090).
 *
 * **Stub mode.** When `STRIPE_SECRET_KEY` is absent (or the explicit
 * `sk_test_stub_*` sentinel is set), the service returns deterministic
 * synthetic transfer ids: `tr_stub_<disbursementId>`. The determinism
 * is load-bearing for the idempotent service-layer retry: a race that
 * lands two `pending` rows for the same scheduling intent collapses on
 * the `idempotency_key` UNIQUE; the loser's transfer id matches the
 * winner's deterministically, so the orphan-transfer case is impossible
 * in stub mode.
 *
 * Live SDK wiring (TS-091-followup-1) will call
 * `stripe.transfers.create({ amount, currency, destination, transfer_group })`
 * with `idempotency_key` passed via Stripe's idempotency header.
 *
 * **Why stub here rather than at the route layer.** Channel-style stubs
 * (mirroring the notification dispatcher pattern) keep the "does the
 * SDK call land?" decision at the I/O boundary. Service-layer code is
 * stub/live agnostic.
 */
@Injectable()
export class StripeTransfersService {
  private readonly logger = new Logger(StripeTransfersService.name);
  private readonly stubMode: boolean;
  private readonly stripeClient: Stripe | null;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.stubMode = isStripeStubMode(env);

    if (this.stubMode || env.STRIPE_SECRET_KEY === undefined) {
      this.stripeClient = null;
    } else {
      this.stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
        apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
        typescript: true,
      });
    }
  }

  /**
   * Initiate a transfer to a connected Express account.
   *
   * **In stub mode** the service returns a deterministic `tr_stub_*`
   * transfer id derived from the disbursement id. No API calls happen.
   *
   * **In live mode** (TS-091-followup-1) this will call
   * `stripe.transfers.create(...)` and propagate Stripe's typed errors
   * to the caller. Today the live branch falls back to the stub generator
   * with a `[live-pending]` warn log so test environments don't break.
   */
  async createTransfer(input: CreateTransferInput): Promise<CreateTransferOutput> {
    if (this.stubMode) {
      const stubId = buildStubTransferId(input.disbursementId);
      this.logger.log(
        `[stub] createTransfer disbursementId=${input.disbursementId} ` +
          `destination=${input.destinationStripeAccountId} ` +
          `amountMinor=${input.amountMinor} currency=${input.currency} ` +
          `stubTransferId=${stubId}`,
      );
      return { stripeTransferId: stubId, liveMode: false };
    }

    this.logger.warn(
      `[live-pending] createTransfer disbursementId=${input.disbursementId} ` +
        `destination=${input.destinationStripeAccountId} ` +
        `amountMinor=${input.amountMinor} currency=${input.currency} ` +
        `— TS-091-followup-1 not yet shipped`,
    );
    const stubId = buildStubTransferId(input.disbursementId);
    return { stripeTransferId: stubId, liveMode: false };
  }

  /** Accessor for the live Stripe client (TS-091-followup-1). */
  getStripeClientForLiveSdkWiring(): Stripe | null {
    return this.stripeClient;
  }

  /** Whether the SDK is configured for live mode. */
  isLiveMode(): boolean {
    return !this.stubMode;
  }
}

export interface CreateTransferInput {
  readonly disbursementId: string;
  readonly destinationStripeAccountId: string;
  readonly amountMinor: number;
  readonly currency: string;
  /** Stripe `transfer_group` — typically `payout:<disbursementId>`. */
  readonly transferGroup: string;
  /**
   * Stripe-level idempotency key (passed as the `Idempotency-Key`
   * header on the live API call). Defaults to `tr:<disbursementId>` so
   * a retry of the SAME disbursement always lands the same transfer.
   */
  readonly idempotencyKey: string;
}

export interface CreateTransferOutput {
  readonly stripeTransferId: string;
  readonly liveMode: boolean;
}

/**
 * Build a deterministic stub Stripe transfer id.
 *
 * Stripe live transfer ids are `tr_` + base58 chars. The stub format is
 * `tr_stub_<disbursementId>` — same `tr_` prefix so the UNIQUE
 * constraint can't collide a stub with a live id.
 *
 * Disbursement ids are cuid2 (24 chars) so the resulting stub is
 * `tr_stub_<24 chars>` = 32 chars total, well under the 64-char column
 * cap. Larger ids get hash-truncated.
 */
function buildStubTransferId(disbursementId: string): string {
  const prefix = 'tr_stub_';
  const maxBase = 64 - prefix.length;
  if (disbursementId.length <= maxBase) {
    return `${prefix}${disbursementId}`;
  }
  let h = 5381;
  for (let i = 0; i < disbursementId.length; i++) {
    h = ((h << 5) + h + disbursementId.charCodeAt(i)) | 0;
  }
  const suffix = Math.abs(h).toString(36).padStart(6, '0').slice(0, 6);
  const head = disbursementId.slice(0, maxBase - 6 - 1);
  return `${prefix}${head}_${suffix}`;
}

export const __testing = { buildStubTransferId };
