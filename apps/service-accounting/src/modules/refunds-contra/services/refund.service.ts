import { Injectable, Logger } from '@nestjs/common';
import type {
  ApplyBookingRefundRequest,
  ApplySubscriptionRefundRequest,
} from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  JournalPostingService,
  type PostJournalFailure,
} from '../../journals/services/journal-posting.service';
import { PlanAccountResolverService } from '../../revenue-recognition/services/plan-account-resolver.service';

/**
 * Chart-of-accounts codes the refund journals touch. Seeded by TS-080's
 * `seedChartOfAccounts`. Hard-coded here because the chart is the
 * authority (CLAUDE.md §4.1) — a change to the code would be a schema
 * migration. Admin tooling can flip an account to `active = false`,
 * which the JournalPostingService rejects with `account_inactive`.
 */
const REFUND_ACCOUNT_CODES = {
  cash: '1000',
  providerPayable: '2100',
  marketplaceRevenue: '4100',
  marketplaceRevenueContra: '4500',
} as const;

/**
 * Failure variants from `RefundService.applySubscriptionRefund`.
 *
 *   - `amount_non_positive` → 422 — a zero refund posts no journal;
 *     the upstream service must filter these before calling.
 *
 *   - `journal_post_failed` → bubbled up from JournalPostingService.
 *     The inner failure carries the specific reason so the controller
 *     can map each variant to the right HTTP status.
 */
export type ApplySubscriptionRefundFailure =
  | { readonly kind: 'amount_non_positive' }
  | {
      readonly kind: 'journal_post_failed';
      readonly failure: PostJournalFailure;
    };

/**
 * Failure variants from `RefundService.applyBookingRefund`.
 *
 *   - `amount_invariant_violated` → 422 — refund != provider +
 *     marketplace at the service layer (the contract enforces this
 *     at parse time too; the service-layer guard defends against
 *     direct callers / future relay-driven entry paths).
 *
 *   - `amount_non_positive` → 422 — refund amount is 0.
 *
 *   - `journal_post_failed` → bubbled up from JournalPostingService.
 */
export type ApplyBookingRefundFailure =
  | { readonly kind: 'amount_invariant_violated' }
  | { readonly kind: 'amount_non_positive' }
  | {
      readonly kind: 'journal_post_failed';
      readonly failure: PostJournalFailure;
    };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(failure: E): Result<never, E> => ({ ok: false, failure });

export interface ApplySubscriptionRefundOutput {
  readonly journalId: string;
  readonly subscriptionId: string;
  readonly planCode: string;
  readonly refundAmountMinor: number;
  readonly currency: 'USD';
  readonly result: 'created' | 'idempotent_replay';
}

export interface ApplyBookingRefundOutput {
  readonly journalId: string;
  readonly bookingId: string;
  readonly providerId: string;
  readonly refundAmountMinor: number;
  readonly providerPortionMinor: number;
  readonly marketplacePortionMinor: number;
  readonly commissionRateBps: number;
  readonly currency: 'USD';
  /**
   * Provider's running payable balance AFTER the decrement (or the
   * unchanged value on replay). May be negative under the clawback
   * flow when a refund arrives after the provider has already been
   * paid out.
   */
  readonly runningPayableMinor: number;
  readonly result: 'created' | 'idempotent_replay';
}

/**
 * `RefundService` — receiver-side of the subscription + booking refund
 * events (TS-084, PDD Appendix A, CLAUDE.md §6).
 *
 * Two public methods:
 *
 *   1. `applySubscriptionRefund` — posts the literal PDD Appendix A
 *      entry: `DR 4000.{planCode} Subscription Revenue $refundAmount /
 *      CR 1000 Cash $refundAmount`. Reverses recognised subscription
 *      revenue against cash. Partial refunds set `refundAmountMinor`
 *      to the refund value (not the full invoice).
 *
 *      **Deferred-revenue cleanup is NOT part of this flow.** A
 *      mid-period cancellation with refund leaves the deferred
 *      liability on the books — the activation journal's
 *      `DR Cash / CR Deferred Revenue` AND the refund journal's
 *      `DR Subscription Revenue / CR Cash` leave the deferred row
 *      untouched. Ops clear the residual deferred amount via a
 *      manual_adjustment journal (or via the TS-084-followup that
 *      automates the cleanup once the upstream signal lands). The
 *      Appendix-A literal example is for fully-recognized refunds
 *      (no deferred remaining); the mid-period nuance is the
 *      caller's responsibility.
 *
 *   2. `applyBookingRefund` — posts the two-leg reversal of the
 *      booking-completion journal:
 *
 *        DR 4100 Marketplace Revenue    $refundAmount
 *        CR 1000 Cash                   $refundAmount
 *        DR 2100 Provider Payable       $providerPortion
 *        CR 4500 Marketplace Revenue Contra $providerPortion
 *
 *      Reverses the gross AND the provider portion AND decrements
 *      the `provider_payable_balances` running balance.
 *
 *      **Clawback semantics.** When the refund arrives AFTER the
 *      provider has been paid out (TS-090/091 has already
 *      disbursed), the running-balance decrement takes the row
 *      negative. The DB has NO CHECK constraint on `amount >= 0`
 *      (per the TS-083 migration design); the negative balance is
 *      the application-layer signal to ops that the provider owes
 *      the platform. The negative-balance ops queue lands as a
 *      TS-084-followup once the surface materialises.
 *
 *      **Two-leg variant.** When `providerPortionMinor === 0` (the
 *      platform eats the entire refund), the journal collapses to
 *      two lines (no contra leg). Mirrors the symmetric collapse in
 *      booking-commission-recognizer's `buildBookingCommissionLines`.
 *      When `marketplacePortionMinor === 0` (full clawback), the
 *      journal still has all four lines — the gross reverse + the
 *      contra reverse — because the full amount touches both legs.
 *
 * **Idempotency.** Both methods are idempotent on `sourceEventId` via
 * the journals.source_event_id UNIQUE. A redelivery returns the
 * existing journal AND the unchanged running balance (the decrement
 * landed on the original post; replaying would double-debit).
 *
 * **Transaction boundary.** The journal post opens its own
 * `prisma.$transaction` inside `JournalPostingService`. For the
 * booking refund, the balance decrement opens a second transaction
 * AFTER the journal post succeeds. The retry path heals via
 * idempotency:
 *   - On replay, we read the running balance WITHOUT decrementing
 *     (the decrement landed on the original post).
 *   - On `created`, we decrement.
 *
 * Same pattern as booking-commission-recognizer's upsert — the
 * Result distinguishes the two cases via a pre-flight journal lookup
 * on `sourceEventId`.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly journals: JournalPostingService,
    private readonly accounts: PlanAccountResolverService,
  ) {}

  /**
   * Post the two-line subscription refund journal per PDD Appendix A.
   *
   * Idempotent on `request.sourceEventId` via the journals.source_event_id
   * UNIQUE. The pre-flight lookup synthesises the `result`
   * discriminator (`'created'` vs `'idempotent_replay'`).
   */
  async applySubscriptionRefund(
    request: ApplySubscriptionRefundRequest,
  ): Promise<Result<ApplySubscriptionRefundOutput, ApplySubscriptionRefundFailure>> {
    if (request.refundAmountMinor <= 0) {
      return fail({ kind: 'amount_non_positive' });
    }

    const existingJournal = await this.prisma.journal.findUnique({
      where: { sourceEventId: request.sourceEventId },
      select: { id: true },
    });
    const isReplay = existingJournal !== null;

    const { revenueAccountCode } = this.accounts.resolve(request.planCode);
    const description =
      request.description ?? `Subscription refund: ${request.subscriptionId} (${request.planCode})`;
    const memo = `subscription ${request.subscriptionId} (${request.planCode}) refund`;
    const currency: 'USD' = request.currency ?? 'USD';

    const postResult = await this.journals.post(
      {
        kind: 'refund',
        occurredAt: request.occurredAt,
        sourceEventId: request.sourceEventId,
        description,
        lines: [
          {
            accountCode: revenueAccountCode,
            debitMinor: request.refundAmountMinor,
            currency,
            memo,
          },
          {
            accountCode: REFUND_ACCOUNT_CODES.cash,
            creditMinor: request.refundAmountMinor,
            currency,
            memo,
          },
        ],
        context: {
          subscriptionId: request.subscriptionId,
          customerId: request.customerId,
          customerGroup: request.customerGroup,
          planCode: request.planCode,
          refundAmountMinor: request.refundAmountMinor,
          ...(request.originalActivationJournalId !== undefined && {
            originalActivationJournalId: request.originalActivationJournalId,
          }),
          ...(request.context ?? {}),
        },
      },
      null,
    );

    if (!postResult.ok) {
      return fail({ kind: 'journal_post_failed', failure: postResult.failure });
    }

    const result: 'created' | 'idempotent_replay' = isReplay ? 'idempotent_replay' : 'created';

    this.logger.log(
      {
        subscriptionId: request.subscriptionId,
        planCode: request.planCode,
        refundAmountMinor: request.refundAmountMinor,
        journalId: postResult.value.id,
        sourceEventId: request.sourceEventId,
        result,
      },
      isReplay ? 'refund.subscription.replay' : 'refund.subscription.applied',
    );

    return ok({
      journalId: postResult.value.id,
      subscriptionId: request.subscriptionId,
      planCode: request.planCode,
      refundAmountMinor: request.refundAmountMinor,
      currency,
      result,
    });
  }

  /**
   * Post the booking refund journal (two-leg reversal) AND decrement
   * the per-provider running payable balance.
   *
   * Decrement is conditional on the journal being NEW (not a replay) —
   * a replay's decrement landed on the original post and re-applying
   * would double-debit.
   */
  async applyBookingRefund(
    request: ApplyBookingRefundRequest,
  ): Promise<Result<ApplyBookingRefundOutput, ApplyBookingRefundFailure>> {
    // Service-layer guards — the contract enforces these at parse time
    // via superRefine, but the second line of defence catches direct
    // callers (e.g. future relay subscribers that bypass HTTP parsing).
    if (request.refundAmountMinor <= 0) {
      return fail({ kind: 'amount_non_positive' });
    }
    if (
      request.providerPortionMinor + request.marketplacePortionMinor !==
      request.refundAmountMinor
    ) {
      return fail({ kind: 'amount_invariant_violated' });
    }

    const existingJournal = await this.prisma.journal.findUnique({
      where: { sourceEventId: request.sourceEventId },
      select: { id: true },
    });
    const isReplay = existingJournal !== null;

    const memo = `booking ${request.bookingId} refund`;
    const description =
      request.description ??
      `Booking refund: ${request.bookingId} (provider ${request.providerId})`;
    const currency: 'USD' = request.currency ?? 'USD';

    const lines = buildBookingRefundLines({
      refundAmountMinor: request.refundAmountMinor,
      providerPortionMinor: request.providerPortionMinor,
      memo,
    });

    const postResult = await this.journals.post(
      {
        kind: 'refund',
        occurredAt: request.occurredAt,
        sourceEventId: request.sourceEventId,
        description,
        lines,
        context: {
          bookingId: request.bookingId,
          providerId: request.providerId,
          householdId: request.householdId,
          commissionRateBps: request.commissionRateBps,
          refundAmountMinor: request.refundAmountMinor,
          providerPortionMinor: request.providerPortionMinor,
          marketplacePortionMinor: request.marketplacePortionMinor,
          ...(request.originalBookingJournalId !== undefined && {
            originalBookingJournalId: request.originalBookingJournalId,
          }),
          ...(request.context ?? {}),
        },
      },
      null,
    );

    if (!postResult.ok) {
      return fail({ kind: 'journal_post_failed', failure: postResult.failure });
    }

    const journalId = postResult.value.id;

    // Decrement path: subtract from the running balance ONLY when this
    // is a first-time post. On replay, the decrement was already
    // applied by the original post — re-applying would double-debit.
    // When providerPortion is 0 (platform eats the entire refund), no
    // decrement is needed — the journal carries no provider-payable
    // leg.
    const runningPayableMinor =
      isReplay || request.providerPortionMinor === 0
        ? await this.readRunningPayableMinor(request.providerId, currency)
        : await this.decrementProviderPayableBalance({
            providerId: request.providerId,
            currency,
            deltaMinor: request.providerPortionMinor,
          });

    const result: 'created' | 'idempotent_replay' = isReplay ? 'idempotent_replay' : 'created';

    this.logger.log(
      {
        bookingId: request.bookingId,
        providerId: request.providerId,
        refundAmountMinor: request.refundAmountMinor,
        providerPortionMinor: request.providerPortionMinor,
        marketplacePortionMinor: request.marketplacePortionMinor,
        commissionRateBps: request.commissionRateBps,
        runningPayableMinor,
        journalId,
        sourceEventId: request.sourceEventId,
        result,
        clawback: runningPayableMinor < 0,
      },
      isReplay ? 'refund.booking.replay' : 'refund.booking.applied',
    );

    return ok({
      journalId,
      bookingId: request.bookingId,
      providerId: request.providerId,
      refundAmountMinor: request.refundAmountMinor,
      providerPortionMinor: request.providerPortionMinor,
      marketplacePortionMinor: request.marketplacePortionMinor,
      commissionRateBps: request.commissionRateBps,
      currency,
      runningPayableMinor,
      result,
    });
  }

  /**
   * Read the provider's running payable balance without mutating it.
   * Returns 0 if no row exists (the provider has had no bookings
   * completed — semantically equivalent to a zero balance).
   *
   * Used on the replay path (where the decrement already happened) and
   * on the no-clawback path (where the platform eats the full refund).
   */
  private async readRunningPayableMinor(providerId: string, currency: 'USD'): Promise<number> {
    const row = await this.prisma.providerPayableBalance.findUnique({
      where: {
        provider_currency_unique: {
          providerId,
          currency,
        },
      },
      select: { amount: true },
    });
    if (row === null) return 0;
    return decimalToMinor(asDecimal(row.amount));
  }

  /**
   * Decrement the running balance row for `(providerId, currency)` by
   * `deltaMinor`. Returns the new running balance in minor units.
   *
   * The upsert handles the case where no row exists yet (a refund
   * arriving for a provider who has never completed a booking — rare
   * but defensively handled): a new row lands with NEGATIVE amount,
   * which is the correct clawback semantic.
   *
   * No DB CHECK constraint defends against negative amounts (per
   * TS-083 migration design); the application-layer negative-balance
   * ops queue handles the surface.
   */
  private async decrementProviderPayableBalance(args: {
    readonly providerId: string;
    readonly currency: 'USD';
    readonly deltaMinor: number;
  }): Promise<number> {
    const deltaDecimal = minorToDecimal(args.deltaMinor);
    const now = new Date();

    const row = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      return tx.providerPayableBalance.upsert({
        where: {
          provider_currency_unique: {
            providerId: args.providerId,
            currency: args.currency,
          },
        },
        create: {
          providerId: args.providerId,
          currency: args.currency,
          // Negative starting balance — refund landed before any
          // booking completion. The clawback path makes this valid.
          amount: deltaDecimal.neg(),
          lastUpdatedAt: now,
        },
        update: {
          amount: { decrement: deltaDecimal },
          lastUpdatedAt: now,
        },
        select: { amount: true },
      });
    });

    return decimalToMinor(asDecimal(row.amount));
  }
}

/**
 * One line of the booking refund journal in the wire shape the shared
 * `JournalPostingService.post` accepts. Mutable so the Prisma-side
 * `lines.create` can consume directly.
 */
export interface BookingRefundJournalLine {
  accountCode: string;
  debitMinor?: number;
  creditMinor?: number;
  currency: 'USD';
  memo: string;
}

/**
 * Build the journal lines for a booking refund. The four-line shape
 * collapses to two lines when `providerPortionMinor === 0` (platform
 * eats the entire refund) — same symmetric collapse as
 * `buildBookingCommissionLines` for the completion journal.
 */
export function buildBookingRefundLines(args: {
  readonly refundAmountMinor: number;
  readonly providerPortionMinor: number;
  readonly memo: string;
}): BookingRefundJournalLine[] {
  const lines: BookingRefundJournalLine[] = [
    // DR 4100 Marketplace Revenue $refundAmount (reverse the gross)
    {
      accountCode: REFUND_ACCOUNT_CODES.marketplaceRevenue,
      debitMinor: args.refundAmountMinor,
      currency: 'USD',
      memo: args.memo,
    },
    // CR 1000 Cash $refundAmount
    {
      accountCode: REFUND_ACCOUNT_CODES.cash,
      creditMinor: args.refundAmountMinor,
      currency: 'USD',
      memo: args.memo,
    },
  ];

  if (args.providerPortionMinor > 0) {
    // DR 2100 Provider Payable $providerPortion (reverse the contra)
    lines.push({
      accountCode: REFUND_ACCOUNT_CODES.providerPayable,
      debitMinor: args.providerPortionMinor,
      currency: 'USD',
      memo: args.memo,
    });
    // CR 4500 Marketplace Revenue Contra $providerPortion
    lines.push({
      accountCode: REFUND_ACCOUNT_CODES.marketplaceRevenueContra,
      creditMinor: args.providerPortionMinor,
      currency: 'USD',
      memo: args.memo,
    });
  }

  return lines;
}

/**
 * Conversion between wire-shape integer minor units (cents) and Prisma
 * `Decimal(12,2)` dollars-and-cents.
 */
function minorToDecimal(minor: number): Decimal {
  return new Decimal(minor).div(100);
}

function decimalToMinor(d: Decimal): number {
  return Number(d.mul(100).toFixed(0));
}

/**
 * Coerce Prisma's runtime Decimal (or any decimal-string-compatible
 * value) into a `decimal.js` instance. Mirrors the helper in
 * booking-commission-recognizer.
 */
function asDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Decimal(value);
  }
  throw new Error(`refund: unexpected non-Decimal value: ${String(value)}`);
}

/**
 * Re-exported for tests / DI containers that want to assert on the
 * canonical chart-of-account codes for refund journals.
 */
export const REFUND_JOURNAL_ACCOUNT_CODES = REFUND_ACCOUNT_CODES;
