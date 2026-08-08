import { Injectable, Logger } from '@nestjs/common';
import type { BookingCommissionRequest } from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  JournalPostingService,
  type PostJournalFailure,
} from '../../journals/services/journal-posting.service';

/**
 * Chart-of-account codes the four-line booking-completion journal touches.
 * The chart is seeded by TS-080's `seedChartOfAccounts` — these codes are
 * stable forever (CLAUDE.md §4.1, the chart is the source of truth for
 * accounts; this constant is the recognizer's resolved reference set).
 *
 * - `1000` — Cash (asset, debit-normal). Increases on customer payment.
 * - `2100` — Provider Payable (liability, credit-normal). Increases on
 *           the contra reclassification of the provider's portion;
 *           decreases on payout disbursement (TS-090/091).
 * - `4100` — Marketplace Revenue (revenue, credit-normal). Gross
 *           merchandise value (GMV) — the customer-paid amount.
 * - `4500` — Marketplace Revenue Contra (contra-revenue, debit-normal).
 *           Reclassifies the provider portion OUT of gross revenue;
 *           net Marketplace Revenue on the income statement is
 *           `4100 - 4500 = platform commission`.
 *
 * Hard-coded here (rather than threaded through configuration) because
 * the chart of accounts is itself the authority — admin tooling
 * (TS-127) can flip an account to `active = false`, which the
 * JournalPostingService rejects with `account_inactive`. A change to
 * the chart's codes would be a schema migration.
 */
const BOOKING_ACCOUNT_CODES = {
  cash: '1000',
  marketplaceRevenue: '4100',
  marketplaceRevenueContra: '4500',
  providerPayable: '2100',
} as const;

/**
 * Failure variants from `BookingCommissionRecognizerService.recognizeBookingCompleted`.
 *
 * `Result<T, E>` discriminated union mirrors `JournalPostingService` and
 * `SubscriptionRevenueRecognizerService` — fallible operations crossing
 * transaction boundaries return Result rather than throwing
 * (CLAUDE.md §2.1). Each variant maps to a controller-side HTTP status.
 *
 * - `amount_invariant_violated` — gross != provider + marketplace at
 *   the service layer (the contract enforces this at parse time too,
 *   but the service-layer guard defends against direct callers /
 *   future relay-driven entry paths).
 *
 * - `amount_non_positive` — gross is 0 (a booking with no money
 *   doesn't post a journal at all — the upstream service must filter
 *   these before calling). Provider portion CAN be 0 (full-platform-
 *   retention promotional booking); marketplace portion CAN be 0
 *   (no-commission booking).
 *
 * - `journal_post_failed` — bubbled up from JournalPostingService.
 *   The inner failure carries the specific reason (account_not_found,
 *   period_closed, etc.) so the controller can map each to the right
 *   HTTP status.
 */
export type RecognizeBookingCompletionFailure =
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

/**
 * Output of `recognizeBookingCompleted`. The runningPayableMinor field
 * reflects the provider's balance AFTER this booking's contribution was
 * applied (or the unchanged balance on an idempotent replay — the
 * upsert is a no-op when the journal already exists).
 */
export interface RecognizeBookingCompletionOutput {
  readonly journalId: string;
  readonly bookingId: string;
  readonly providerId: string;
  readonly grossAmountMinor: number;
  readonly providerAmountMinor: number;
  readonly marketplaceAmountMinor: number;
  readonly commissionRateBps: number;
  readonly currency: 'USD';
  readonly runningPayableMinor: number;
  readonly result: 'created' | 'idempotent_replay';
}

/**
 * `BookingCommissionRecognizerService` — receiver-side of the
 * `booking.completed` event (TS-083, PDD §9.2, Appendix A).
 *
 * One public method: `recognizeBookingCompleted(request)`. The
 * orchestration:
 *
 *   1. Service-layer invariant guard — gross == provider + marketplace,
 *      gross > 0. (The contract enforces the same invariant at parse
 *      time; this is the second line of defence for direct callers.)
 *
 *   2. Post the four-line journal via JournalPostingService:
 *
 *        DR Cash                              $gross
 *        CR Marketplace Revenue (gross)       $gross
 *        DR Marketplace Revenue Contra        $providerPortion
 *        CR Provider Payable                  $providerPortion
 *
 *      Idempotent on `sourceEventId`: a redelivery returns the
 *      previously-posted journal via the journals.source_event_id
 *      UNIQUE replay path. The `result` field distinguishes the two
 *      cases for the caller.
 *
 *   3. Upsert the `provider_payable_balances` row for the provider:
 *      `amount += providerAmountMinor`. The upsert is wrapped in a
 *      transaction so a concurrent completion against the same
 *      provider doesn't race the running balance.
 *
 *   4. Return `{ journalId, runningPayableMinor, result }` — the
 *      controller surfaces the updated balance so the caller can
 *      render it without a second round-trip.
 *
 * **Idempotency.** Same shape as TS-082's recognizer:
 *   - The journal post is idempotent on `sourceEventId` (journals.
 *     source_event_id UNIQUE → JournalPostingService replays the
 *     existing journal).
 *   - The balance upsert is idempotent on the journal's existence:
 *     if `journal_post_failed` returns `kind: ok` AND `result:
 *     idempotent_replay` (the journal already existed), we know the
 *     completion was previously applied — the upsert becomes a no-op
 *     (the running balance already includes this booking's portion).
 *
 * **Transaction boundary.** The journal post opens its own
 * `prisma.$transaction`. The balance upsert opens a second
 * transaction AFTER the journal post succeeds. The retry path heals
 * via idempotency: if the journal post succeeds but the upsert
 * fails, the next completion against the same `sourceEventId` (or a
 * manual redelivery from ops) replays the journal as `idempotent_
 * replay` and re-attempts the upsert — but only if the journal-replay
 * path can distinguish "this is a first-time replay → need to apply
 * the increment" from "this is a true replay → don't double-count".
 *
 * The clean shape: on `idempotent_replay`, we read the running
 * balance row WITHOUT incrementing (the increment landed on the
 * original post; replaying would double-count). On `created`, we
 * increment. The distinction lives on the JournalPostingService's
 * `result` value (we synthesise our own from the journal id we just
 * posted vs. the one we found on replay) — see implementation note
 * below.
 *
 * **Provider Payable Balance materialised view.** The running balance
 * is provably equivalent to `SUM(credit) - SUM(debit) FROM
 * journal_lines WHERE account_id = (the 2100 account) GROUP BY
 * provider_id`, derived from `journals.context.providerId`. The
 * materialised view is the working state; the ledger is the source of
 * truth. The TS-090 payouts service decrements the balance on Stripe
 * transfer success; the TS-084 refund flow can drive it negative.
 *
 * **No tenant scoping** — the accounting service is staff-only at the
 * row level (CLAUDE.md §3.2). Row-level checks live in the controller
 * (the internal endpoint is shared-secret-pinned; the admin read is
 * AccessTokenGuard-gated).
 */
@Injectable()
export class BookingCommissionRecognizerService {
  private readonly logger = new Logger(BookingCommissionRecognizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly journals: JournalPostingService,
  ) {}

  /**
   * Post the four-line booking-completion journal AND upsert the
   * provider's running payable balance.
   *
   * The upsert is conditional on the journal being NEW (not a replay) —
   * a replay's increment landed on the original post and re-applying
   * would double-count.
   */
  async recognizeBookingCompleted(
    request: BookingCommissionRequest,
  ): Promise<Result<RecognizeBookingCompletionOutput, RecognizeBookingCompletionFailure>> {
    // Service-layer guards — the contract enforces these at parse
    // time, but the second line of defence catches direct callers.
    if (request.grossAmountMinor <= 0) {
      return fail({ kind: 'amount_non_positive' });
    }
    if (request.providerAmountMinor + request.marketplaceAmountMinor !== request.grossAmountMinor) {
      return fail({ kind: 'amount_invariant_violated' });
    }

    // Pre-flight: is the journal already posted under this
    // sourceEventId? If yes, this is a replay — return the existing
    // journal's id WITHOUT incrementing the running balance. We need
    // to know this BEFORE calling JournalPostingService.post because
    // its `ok(...)` Result doesn't carry a created-vs-replayed signal
    // (the post path is idempotent and returns the persisted row
    // whether it just inserted or refetched on P2002).
    const existingJournal = await this.prisma.journal.findUnique({
      where: { sourceEventId: request.sourceEventId },
      select: { id: true },
    });
    const isReplay = existingJournal !== null;

    const memo = `booking ${request.bookingId}`;
    const description =
      request.description ??
      `Booking completion: ${request.bookingId} (provider ${request.providerId})`;

    // Post the four-line journal. The MARKETPLACE REVENUE CONTRA leg
    // only lands when there IS a provider portion — a 100%-platform
    // booking (providerAmountMinor === 0) posts a two-line journal
    // (DR Cash / CR Marketplace Revenue) only, because the contra
    // reclassification has zero value to move. Same applies symmetrically
    // for 0% commission (marketplaceAmountMinor === 0): the contra
    // reclassifies the FULL gross to provider payable.
    const lines = buildBookingCommissionLines({
      grossAmountMinor: request.grossAmountMinor,
      providerAmountMinor: request.providerAmountMinor,
      marketplaceAmountMinor: request.marketplaceAmountMinor,
      memo,
    });

    const postResult = await this.journals.post(
      {
        kind: 'booking_completion',
        occurredAt: request.completedAt,
        sourceEventId: request.sourceEventId,
        description,
        lines,
        context: {
          bookingId: request.bookingId,
          providerId: request.providerId,
          householdId: request.householdId,
          commissionRateBps: request.commissionRateBps,
          grossAmountMinor: request.grossAmountMinor,
          providerAmountMinor: request.providerAmountMinor,
          marketplaceAmountMinor: request.marketplaceAmountMinor,
          ...(request.context ?? {}),
        },
      },
      null,
    );

    if (!postResult.ok) {
      return fail({ kind: 'journal_post_failed', failure: postResult.failure });
    }

    const journalId = postResult.value.id;

    // Upsert path: increment the running balance ONLY when this is a
    // first-time post. On replay, the increment was already applied
    // by the original post — re-applying would double-count.
    const currency: 'USD' = request.currency ?? 'USD';
    const runningPayableMinor = isReplay
      ? await this.readRunningPayableMinor(request.providerId, currency)
      : await this.upsertProviderPayableBalance({
          providerId: request.providerId,
          currency,
          deltaMinor: request.providerAmountMinor,
        });

    const result: 'created' | 'idempotent_replay' = isReplay ? 'idempotent_replay' : 'created';

    this.logger.log(
      {
        bookingId: request.bookingId,
        providerId: request.providerId,
        journalId,
        grossAmountMinor: request.grossAmountMinor,
        providerAmountMinor: request.providerAmountMinor,
        marketplaceAmountMinor: request.marketplaceAmountMinor,
        commissionRateBps: request.commissionRateBps,
        runningPayableMinor,
        sourceEventId: request.sourceEventId,
        result,
      },
      isReplay ? 'booking-commission.replay' : 'booking-commission.recognized',
    );

    return ok({
      journalId,
      bookingId: request.bookingId,
      providerId: request.providerId,
      grossAmountMinor: request.grossAmountMinor,
      providerAmountMinor: request.providerAmountMinor,
      marketplaceAmountMinor: request.marketplaceAmountMinor,
      commissionRateBps: request.commissionRateBps,
      currency,
      runningPayableMinor,
      result,
    });
  }

  /**
   * Read the provider's running payable balance.
   *
   * Returns the running balance in minor units; if no row exists for
   * the (provider, currency) pair, returns 0 (the provider has had no
   * bookings completed yet — semantically equivalent to a zero
   * balance).
   */
  async readRunningPayableMinor(providerId: string, currency: 'USD'): Promise<number> {
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
   * Return the row carrying the provider's running balance + the most
   * recent mutation timestamp. Returns `null` if no booking has been
   * completed for this provider in this currency.
   */
  async getProviderPayableBalance(
    providerId: string,
    currency: 'USD',
  ): Promise<{
    readonly providerId: string;
    readonly currency: 'USD';
    readonly amountMinor: number;
    readonly lastUpdatedAt: Date;
  } | null> {
    const row = await this.prisma.providerPayableBalance.findUnique({
      where: {
        provider_currency_unique: {
          providerId,
          currency,
        },
      },
      select: { amount: true, currency: true, lastUpdatedAt: true },
    });
    if (row === null) return null;
    return {
      providerId,
      currency: narrowCurrency(row.currency),
      amountMinor: decimalToMinor(asDecimal(row.amount)),
      lastUpdatedAt: row.lastUpdatedAt,
    };
  }

  /**
   * Upsert the running balance row for `(providerId, currency)`,
   * incrementing by `deltaMinor`. Returns the new running balance in
   * minor units.
   *
   * The upsert is the standard Prisma create-or-update; the composite
   * UNIQUE on `(provider_id, currency)` makes the conflict target. A
   * concurrent completion against the same provider races at the
   * UNIQUE level — Postgres serialises the two, and the second
   * upsert's update path reads the post-increment value from the
   * winner.
   */
  private async upsertProviderPayableBalance(args: {
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
          amount: deltaDecimal,
          lastUpdatedAt: now,
        },
        update: {
          amount: { increment: deltaDecimal },
          lastUpdatedAt: now,
        },
        select: { amount: true },
      });
    });

    return decimalToMinor(asDecimal(row.amount));
  }
}

/**
 * One line of the booking-completion journal in the wire shape the
 * shared `JournalPostingService.post` accepts. Mutable so the
 * Prisma-side `lines.create` can consume directly.
 */
export interface BookingCommissionJournalLine {
  accountCode: string;
  debitMinor?: number;
  creditMinor?: number;
  currency: 'USD';
  memo: string;
}

/**
 * Build the journal lines for a booking completion. The four-line
 * shape collapses to two lines when the provider portion is zero (a
 * 100%-platform-retention booking) — keeping the journal minimal
 * preserves the double-entry invariant without an empty leg.
 */
export function buildBookingCommissionLines(args: {
  readonly grossAmountMinor: number;
  readonly providerAmountMinor: number;
  readonly marketplaceAmountMinor: number;
  readonly memo: string;
}): BookingCommissionJournalLine[] {
  const lines: BookingCommissionJournalLine[] = [
    // DR Cash $gross
    {
      accountCode: BOOKING_ACCOUNT_CODES.cash,
      debitMinor: args.grossAmountMinor,
      currency: 'USD',
      memo: args.memo,
    },
    // CR Marketplace Revenue $gross
    {
      accountCode: BOOKING_ACCOUNT_CODES.marketplaceRevenue,
      creditMinor: args.grossAmountMinor,
      currency: 'USD',
      memo: args.memo,
    },
  ];

  if (args.providerAmountMinor > 0) {
    // DR Marketplace Revenue Contra $providerPortion
    lines.push({
      accountCode: BOOKING_ACCOUNT_CODES.marketplaceRevenueContra,
      debitMinor: args.providerAmountMinor,
      currency: 'USD',
      memo: args.memo,
    });
    // CR Provider Payable $providerPortion
    lines.push({
      accountCode: BOOKING_ACCOUNT_CODES.providerPayable,
      creditMinor: args.providerAmountMinor,
      currency: 'USD',
      memo: args.memo,
    });
  }

  return lines;
}

/**
 * Conversion between wire-shape integer minor units (cents) and
 * Prisma `Decimal(12,2)` dollars-and-cents.
 */
function minorToDecimal(minor: number): Decimal {
  return new Decimal(minor).div(100);
}

function decimalToMinor(d: Decimal): number {
  return Number(d.mul(100).toFixed(0));
}

/**
 * Coerce Prisma's runtime Decimal (or any decimal-string-compatible
 * value) into a `decimal.js` instance. Prisma's Decimal class is
 * structurally compatible at `.toString()`.
 */
function asDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Decimal(value);
  }
  throw new Error(`booking-commission: unexpected non-Decimal value: ${String(value)}`);
}

function narrowCurrency(value: string): 'USD' {
  if (value !== 'USD') {
    throw new Error(`booking-commission: unsupported currency on persisted balance: ${value}`);
  }
  return 'USD';
}

/**
 * Re-exported for tests / DI containers that want to assert on the
 * canonical chart-of-account codes for booking completion.
 */
export const BOOKING_COMMISSION_ACCOUNT_CODES = BOOKING_ACCOUNT_CODES;
