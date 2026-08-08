import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

import { ENV_TOKEN } from '../../../config/config.module';
import { isStripeStubMode, type Env } from '../../../config/env';

/**
 * Stripe's reported figures for one reconciliation window (TS-261).
 *   - `balanceMinor` — current Stripe balance (available + pending) for the
 *     reconciled currency, in minor units. A point-in-time snapshot.
 *   - `activityNetMinor` — Σ `net` of every balance transaction whose
 *     `created` falls in the day window, in minor units (net of Stripe
 *     fees).
 *   - `transactionCount` — count of balance transactions scanned.
 */
export interface StripeDayReport {
  readonly balanceMinor: number;
  readonly activityNetMinor: number;
  readonly transactionCount: number;
}

/** Minimal shape of a Stripe balance amount entry (`{ amount, currency }`). */
interface StripeAmountLike {
  readonly amount: number;
  readonly currency: string;
}

/** Minimal shape of a Stripe balance-transaction (`{ net, currency }`). */
interface StripeBalanceTxnLike {
  readonly net: number;
  readonly currency: string;
}

/**
 * Sum a Stripe balance's `available` + `pending` entries for one currency,
 * in minor units. Stripe currency codes are lower-case ISO 4217 (`usd`);
 * the caller passes the lower-cased code. Pure — unit-tested directly.
 */
export function summarizeBalance(
  balance: {
    readonly available: readonly StripeAmountLike[];
    readonly pending: readonly StripeAmountLike[];
  },
  currency: string,
): number {
  let total = 0;
  for (const entry of [...balance.available, ...balance.pending]) {
    if (entry.currency === currency) {
      total += entry.amount;
    }
  }
  return total;
}

/**
 * Sum the `net` of balance transactions for one currency + count them, in
 * minor units. Pure — unit-tested directly.
 */
export function summarizeActivity(
  transactions: Iterable<StripeBalanceTxnLike>,
  currency: string,
): { readonly netMinor: number; readonly count: number } {
  let netMinor = 0;
  let count = 0;
  for (const txn of transactions) {
    if (txn.currency !== currency) continue;
    netMinor += txn.net;
    count += 1;
  }
  return { netMinor, count };
}

/**
 * Reads Stripe's reported balance + balance-transaction activity for a
 * reconciliation window (TS-261, PDD §11.2). Mirrors the stub-mode posture
 * of service-payouts' `StripeTransfersService`: when no live secret key is
 * configured (Phase 1) the reader returns `null` — the reconciliation
 * cannot query Stripe, so the service records a `skipped_stub` checkpoint
 * rather than fabricating a comparison.
 *
 * **Pagination.** The live branch iterates `stripe.balanceTransactions.list`
 * with `for await` — the SDK's auto-pagination iterator transparently walks
 * every page via `starting_after` cursors, so a high-volume day is summed
 * without manual cursor bookkeeping (the acceptance's "pulls Stripe via the
 * SDK pagination API").
 *
 * **Live SDK wiring is exercised in deployed environments only.** Unit
 * tests cover the stub-`null` branch + the pure `summarizeBalance` /
 * `summarizeActivity` helpers; a Testcontainers/stripe-test-mode round-trip
 * of the live branch is TS-261-followup-3.
 */
@Injectable()
export class StripeReportReader {
  private readonly logger = new Logger(StripeReportReader.name);
  private readonly stubMode: boolean;
  private readonly stripeClient: Stripe | null;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.stubMode = isStripeStubMode(env);
    this.stripeClient =
      this.stubMode || env.STRIPE_SECRET_KEY === undefined
        ? null
        : new Stripe(env.STRIPE_SECRET_KEY, {
            apiVersion: env.STRIPE_API_VERSION as Stripe.LatestApiVersion,
            typescript: true,
          });
  }

  /** Whether the reader is configured for live Stripe queries. */
  isLiveMode(): boolean {
    return !this.stubMode;
  }

  /**
   * Read Stripe's figures for the `[start, end)` window. Returns `null` in
   * stub mode (no live Stripe). The reconciled currency is lower-case ISO
   * 4217 (`usd`) — Stripe's convention.
   */
  async read(window: {
    readonly start: Date;
    readonly end: Date;
    readonly currency: string;
  }): Promise<StripeDayReport | null> {
    if (this.stubMode || this.stripeClient === null) {
      return null;
    }
    const currency = window.currency.toLowerCase();
    const client = this.stripeClient;

    const balance = await client.balance.retrieve();
    const balanceMinor = summarizeBalance(balance, currency);

    let activityNetMinor = 0;
    let transactionCount = 0;
    const createdGte = Math.floor(window.start.getTime() / 1000);
    const createdLt = Math.floor(window.end.getTime() / 1000);
    for await (const txn of client.balanceTransactions.list({
      created: { gte: createdGte, lt: createdLt },
      limit: 100,
    })) {
      if (txn.currency !== currency) continue;
      activityNetMinor += txn.net;
      transactionCount += 1;
    }

    this.logger.log(
      {
        balanceMinor,
        activityNetMinor,
        transactionCount,
        windowStart: window.start.toISOString(),
        windowEnd: window.end.toISOString(),
      },
      'stripe-reconciliation.stripe-report.read',
    );

    return { balanceMinor, activityNetMinor, transactionCount };
  }
}
