import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PayoutSweepProviderSummary } from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

import {
  type DisbursementRecord,
  DisbursementsService,
  type ScheduleDisbursementInput,
  type ScheduleDisbursementResult,
} from './disbursements.service';
import { PayableBalanceProvider, type BalanceSnapshot } from './payable-balance.provider';
import { PayoutAccountsService } from '../../connect/services/payout-accounts.service';

/**
 * Daily disbursement sweep orchestrator (TS-091; PDD §11.3 "T+2 schedule
 * with hold for completed bookings").
 *
 * **Sweep flow.**
 *
 *   1. Resolve the candidate provider set (operator-supplied
 *      `providerIds` allow-list or every payout account in `active`
 *      status).
 *   2. For each provider, read the running payable balance from the
 *      PayableBalanceProvider (Phase 1: stub in-memory store; future
 *      Phase 2: HTTP read against service-accounting via the gateway).
 *   3. Apply per-provider gates:
 *        - Payout account exists + status === 'active'
 *        - Balance ≥ `minAmountMinor` floor
 *        - Hold window cleared: `balance.lastUpdatedAt + holdDays`
 *          must be ≤ `asOfDate + 1 day` so no booking-completion
 *          inside the hold window contributed to this disbursement.
 *   4. For survivors, call `DisbursementsService.scheduleDisbursement`
 *      with a deterministic `idempotencyKey` of `sweep:<asOfDate>:
 *      <providerId>`. Idempotent across re-runs of the same date.
 *   5. In `dryRun` mode, skip the scheduling call but still report the
 *      decision so the operator can preview the run.
 *
 * **Decision taxonomy** mirrors `PayoutSweepProviderSummary` from the
 * contracts package. Every provider gets one row in the response —
 * including the skipped ones — so operator audit is complete.
 *
 * **No BullMQ wiring yet.** The sweep runs synchronously from the
 * admin trigger endpoint in Phase 1. The scheduled-cron worker
 * (`apps/workers/payouts-disbursement-sweep`) lands as TS-091-followup-5
 * once BullMQ is on the dependency list. The orchestrator's
 * `runSweep(...)` method is the entry point both paths will use.
 */
@Injectable()
export class DisbursementSchedulerService {
  private readonly logger = new Logger(DisbursementSchedulerService.name);
  private readonly defaultHoldDays: number;
  private readonly defaultMinAmountMinor: number;
  private readonly defaultCurrency: string;

  constructor(
    @Inject(ENV_TOKEN) env: Env,
    private readonly disbursements: DisbursementsService,
    private readonly accounts: PayoutAccountsService,
    private readonly balances: PayableBalanceProvider,
  ) {
    this.defaultHoldDays = env.PAYOUT_HOLD_DAYS;
    this.defaultMinAmountMinor = env.PAYOUT_MIN_AMOUNT_MINOR;
    this.defaultCurrency = env.PAYOUT_DEFAULT_CURRENCY;
  }

  async runSweep(input: RunSweepInput): Promise<RunSweepResult> {
    const holdDays = input.holdDays ?? this.defaultHoldDays;
    const minAmountMinor = input.minAmountMinor ?? this.defaultMinAmountMinor;
    const dryRun = input.dryRun ?? false;
    const currency = this.defaultCurrency;

    // The asOfDate boundary is interpreted as midnight UTC of the
    // requested calendar date (the scheduler stamps disbursements with
    // that calendar date and computes the hold window from it).
    const asOfDate = parseCalendarDate(input.asOfDate);
    const asOfPlusOneDay = new Date(asOfDate.getTime() + 24 * 60 * 60 * 1000);

    const resolveInput: { readonly currency: string; readonly providerIds?: readonly string[] } =
      input.providerIds === undefined ? { currency } : { currency, providerIds: input.providerIds };
    const candidates = await this.resolveCandidates(resolveInput);

    const perProvider: PayoutSweepProviderSummary[] = [];
    let scheduledCount = 0;
    let idempotentExistingCount = 0;
    let skippedCount = 0;
    let totalScheduledAmountMinor = 0;

    for (const candidate of candidates) {
      const summary = await this.evaluateAndSchedule({
        candidate,
        holdDays,
        minAmountMinor,
        asOfDate,
        asOfPlusOneDay,
        dryRun,
      });
      perProvider.push(summary);
      switch (summary.decision) {
        case 'scheduled':
          scheduledCount += 1;
          totalScheduledAmountMinor += summary.amountMinor;
          break;
        case 'idempotent_existing':
          idempotentExistingCount += 1;
          break;
        default:
          skippedCount += 1;
      }
    }

    this.logger.log(
      `sweep asOf=${input.asOfDate} candidates=${candidates.length} ` +
        `scheduled=${scheduledCount} idempotent=${idempotentExistingCount} ` +
        `skipped=${skippedCount} totalAmountMinor=${totalScheduledAmountMinor} dryRun=${dryRun}`,
    );

    return {
      asOfDate: input.asOfDate,
      holdDays,
      minAmountMinor,
      dryRun,
      consideredProviderCount: candidates.length,
      scheduledCount,
      idempotentExistingCount,
      skippedCount,
      totalScheduledAmountMinor,
      currency,
      perProvider,
    };
  }

  /**
   * Resolve the providerId universe for this sweep. When the operator
   * supplied an allow-list, each id is paired with the matching balance
   * snapshot (if any). Otherwise every balance row in the configured
   * currency is considered.
   */
  private async resolveCandidates(args: {
    readonly currency: string;
    readonly providerIds?: readonly string[];
  }): Promise<readonly Candidate[]> {
    const balanceFilter: { readonly currency: string; readonly providerIds?: readonly string[] } =
      args.providerIds === undefined
        ? { currency: args.currency }
        : { currency: args.currency, providerIds: args.providerIds };

    const balances = await this.balances.listAllBalances(balanceFilter);

    if (args.providerIds === undefined) {
      return (balances ?? []).map((balance) => ({
        providerId: balance.providerId,
        balance,
      }));
    }

    // When an allow-list is supplied, materialise a Candidate for every
    // requested provider — even if no balance exists. This lets the
    // sweep return a `skipped_no_balance` decision for the operator's
    // audit instead of silently dropping the provider from the response.
    const byProviderId = new Map<string, BalanceSnapshot>();
    for (const snapshot of balances ?? []) {
      byProviderId.set(snapshot.providerId, snapshot);
    }
    return args.providerIds.map((providerId) => {
      const balance = byProviderId.get(providerId);
      const candidate: Candidate = balance === undefined ? { providerId } : { providerId, balance };
      return candidate;
    });
  }

  private async evaluateAndSchedule(args: {
    readonly candidate: Candidate;
    readonly holdDays: number;
    readonly minAmountMinor: number;
    readonly asOfDate: Date;
    readonly asOfPlusOneDay: Date;
    readonly dryRun: boolean;
  }): Promise<PayoutSweepProviderSummary> {
    const { candidate, holdDays, minAmountMinor, asOfDate, asOfPlusOneDay, dryRun } = args;

    // Gate 1: payout account exists.
    const account = await this.accounts.getByProvider(candidate.providerId);
    if (account === null) {
      return zeroAmountSummary(candidate.providerId, 'skipped_no_account');
    }

    // Gate 2: payout account is `active` (PRD §11.3 — disbursement
    // halted on `restricted` / `disabled` / `pending_onboarding`).
    if (account.status !== 'active') {
      return zeroAmountSummary(candidate.providerId, 'skipped_account_not_active');
    }

    // Gate 3: a payable-balance row exists.
    if (candidate.balance === undefined) {
      return zeroAmountSummary(candidate.providerId, 'skipped_no_balance');
    }

    // Gate 4: balance ≥ floor.
    if (candidate.balance.amountMinor < minAmountMinor) {
      return {
        providerId: candidate.providerId,
        decision: 'skipped_below_threshold',
        amountMinor: candidate.balance.amountMinor,
        currency: candidate.balance.currency,
        scheduledDisbursementId: null,
      };
    }

    // Gate 5: hold window cleared.
    //
    //   "T+2 hold" means: no booking-completion that contributed to the
    //   current balance is younger than holdDays calendar days. We
    //   approximate by checking the balance row's `lastUpdatedAt` —
    //   if the last booking-completion landed within the hold window,
    //   we wait. This is a defensive heuristic; the precise per-line
    //   hold check would require walking every journal line that
    //   contributed to the balance, which we defer (TS-091-followup-6).
    const holdCutoff = new Date(asOfPlusOneDay.getTime() - holdDays * 24 * 60 * 60 * 1000);
    if (candidate.balance.lastUpdatedAt.getTime() >= holdCutoff.getTime()) {
      return {
        providerId: candidate.providerId,
        decision: 'skipped_hold_not_cleared',
        amountMinor: candidate.balance.amountMinor,
        currency: candidate.balance.currency,
        scheduledDisbursementId: null,
      };
    }

    if (dryRun) {
      return {
        providerId: candidate.providerId,
        decision: 'skipped_dry_run',
        amountMinor: candidate.balance.amountMinor,
        currency: candidate.balance.currency,
        scheduledDisbursementId: null,
      };
    }

    const scheduleInput: ScheduleDisbursementInput = {
      providerId: candidate.providerId,
      amountMinor: candidate.balance.amountMinor,
      currency: candidate.balance.currency,
      idempotencyKey: buildSweepIdempotencyKey(args.asOfDate, candidate.providerId),
      scheduledFor: asOfDate,
      holdDays,
    };

    const result: ScheduleDisbursementResult =
      await this.disbursements.scheduleDisbursement(scheduleInput);

    switch (result.outcome) {
      case 'created':
        return scheduledSummary(candidate.providerId, result.disbursement, 'scheduled');
      case 'existing':
        return scheduledSummary(candidate.providerId, result.disbursement, 'idempotent_existing');
      case 'account_not_found':
        // Race: the account was deleted between gate 1 and the schedule
        // call. Surface as `skipped_no_account` for the operator audit.
        return zeroAmountSummary(candidate.providerId, 'skipped_no_account');
      case 'account_not_active':
        return zeroAmountSummary(candidate.providerId, 'skipped_account_not_active');
    }
  }
}

export interface RunSweepInput {
  readonly asOfDate: string;
  readonly holdDays?: number;
  readonly minAmountMinor?: number;
  readonly providerIds?: readonly string[];
  readonly dryRun?: boolean;
}

export interface RunSweepResult {
  readonly asOfDate: string;
  readonly holdDays: number;
  readonly minAmountMinor: number;
  readonly dryRun: boolean;
  readonly consideredProviderCount: number;
  readonly scheduledCount: number;
  readonly idempotentExistingCount: number;
  readonly skippedCount: number;
  readonly totalScheduledAmountMinor: number;
  readonly currency: string;
  readonly perProvider: readonly PayoutSweepProviderSummary[];
}

interface Candidate {
  readonly providerId: string;
  readonly balance?: BalanceSnapshot;
}

function buildSweepIdempotencyKey(asOfDate: Date, providerId: string): string {
  const yyyy = asOfDate.getUTCFullYear().toString().padStart(4, '0');
  const mm = (asOfDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = asOfDate.getUTCDate().toString().padStart(2, '0');
  return `sweep:${yyyy}-${mm}-${dd}:${providerId}`;
}

function parseCalendarDate(yyyymmdd: string): Date {
  const [yStr, mStr, dStr] = yyyymmdd.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

function zeroAmountSummary(
  providerId: string,
  decision: PayoutSweepProviderSummary['decision'],
): PayoutSweepProviderSummary {
  return {
    providerId,
    decision,
    amountMinor: 0,
    currency: 'USD',
    scheduledDisbursementId: null,
  };
}

function scheduledSummary(
  providerId: string,
  disbursement: DisbursementRecord,
  decision: 'scheduled' | 'idempotent_existing',
): PayoutSweepProviderSummary {
  return {
    providerId,
    decision,
    amountMinor: disbursement.amountMinor,
    currency: disbursement.currency,
    scheduledDisbursementId: disbursement.id,
  };
}

export const __testing = { buildSweepIdempotencyKey, parseCalendarDate };
