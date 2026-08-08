import { Injectable, Logger } from '@nestjs/common';

/**
 * Read-side abstraction over the `provider_payable_balances` materialised
 * view that lives in service-accounting (TS-083).
 *
 * Phase 1 (TS-091) ships the **stub** implementation by default: an
 * in-memory store the operator can seed via the admin tooling (or, in
 * tests, via a direct injection). This avoids a hard cross-service HTTP
 * dependency for the initial scheduler slice — the live HTTP client
 * lands as TS-091-followup-2 once the api-gateway BFF (TS-140) is the
 * canonical fan-out.
 *
 * **Why an interface instead of a hard HTTP call.** service-payouts and
 * service-accounting are independent bounded contexts (CLAUDE.md §2.3).
 * Cross-service reads MUST go through gateway aggregation or events —
 * direct HTTP from one service to another's admin endpoint is allowed
 * for internal-only paths but should be a swappable adapter so the
 * scheduler can be unit-tested without an HTTP server. The interface
 * stays stable when the eventual live client (HTTP via the BFF, or an
 * outbox-event-driven local cache) lands.
 *
 * **Latest mutation timestamp.** Every balance lookup also returns the
 * "last credited at" timestamp from the underlying balance row. The
 * scheduler compares this to `held_until` (now - holdDays) to enforce
 * the T+2 hold window: a disbursement is permitted only when every
 * booking-completion that fed the balance is past its hold cut-off.
 *
 * For the Phase 1 stub, the operator supplies the last-credited-at on
 * `setBalance`. In production this comes from the accounting service's
 * `lastUpdatedAt` column on the provider_payable_balances row.
 */
@Injectable()
export class PayableBalanceProvider {
  private readonly logger = new Logger(PayableBalanceProvider.name);
  private readonly store = new Map<string, BalanceSnapshot>();

  /**
   * Read the balance for `(providerId, currency)`. Returns `null` when no
   * row exists for the pair (the provider has had no booking completions
   * in this currency — semantically a zero balance, but we return null
   * so the caller can distinguish "no row" from "zero balance").
   */
  async getBalance(input: ReadBalanceInput): Promise<BalanceSnapshot | null> {
    const key = makeKey(input.providerId, input.currency);
    return this.store.get(key) ?? null;
  }

  /**
   * Read every provider's balance in a single call. Used by the daily
   * sweep when the `providerIds` filter is not supplied.
   *
   * In Phase 1 stub mode, this returns every entry in the in-memory
   * store. In the eventual live HTTP implementation, this maps to a
   * paginated `GET /api/v1/admin/payouts/payable-balances` call against
   * service-accounting (TS-091-followup-2 introduces that endpoint).
   */
  async listAllBalances(input: ListBalancesInput): Promise<readonly BalanceSnapshot[] | null> {
    if (input.providerIds !== undefined) {
      const matched: BalanceSnapshot[] = [];
      for (const providerId of input.providerIds) {
        const snapshot = this.store.get(makeKey(providerId, input.currency));
        if (snapshot !== undefined) matched.push(snapshot);
      }
      return matched;
    }

    const entries: BalanceSnapshot[] = [];
    for (const snapshot of this.store.values()) {
      if (snapshot.currency === input.currency) entries.push(snapshot);
    }
    return entries;
  }

  /**
   * Operator-facing primitive used by the admin "trigger a sweep" path
   * and by tests to seed the in-memory store. The eventual live HTTP
   * client (TS-091-followup-2) won't expose this — balances come from
   * the source-of-truth ledger.
   */
  setBalance(snapshot: BalanceSnapshot): void {
    const key = makeKey(snapshot.providerId, snapshot.currency);
    this.store.set(key, snapshot);
    this.logger.log(
      `[stub] setBalance providerId=${snapshot.providerId} ` +
        `currency=${snapshot.currency} amountMinor=${snapshot.amountMinor}`,
    );
  }

  /** Test-only convenience: clear the in-memory store. */
  resetForTesting(): void {
    this.store.clear();
  }

  /**
   * Decrement the cached balance after a successful disbursement. The
   * source-of-truth decrement happens in service-accounting (via the
   * TS-091-followup-3 accounting postback); this is a hint for the
   * stub-mode in-memory cache to stay consistent within a test run.
   */
  decrementBalanceForStubMode(input: {
    readonly providerId: string;
    readonly currency: string;
    readonly amountMinor: number;
  }): void {
    const key = makeKey(input.providerId, input.currency);
    const existing = this.store.get(key);
    if (existing === undefined) return;
    const next: BalanceSnapshot = {
      providerId: existing.providerId,
      currency: existing.currency,
      amountMinor: Math.max(0, existing.amountMinor - input.amountMinor),
      lastUpdatedAt: new Date(),
    };
    this.store.set(key, next);
  }
}

export interface BalanceSnapshot {
  readonly providerId: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly lastUpdatedAt: Date;
}

export interface ReadBalanceInput {
  readonly providerId: string;
  readonly currency: string;
}

export interface ListBalancesInput {
  readonly currency: string;
  readonly providerIds?: readonly string[];
}

function makeKey(providerId: string, currency: string): string {
  return `${providerId}::${currency}`;
}
