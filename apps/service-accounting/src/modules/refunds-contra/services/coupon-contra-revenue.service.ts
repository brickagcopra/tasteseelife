import { Injectable, Logger } from '@nestjs/common';
import type { ApplyCouponRedemptionRequest } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import {
  JournalPostingService,
  type PostJournalFailure,
} from '../../journals/services/journal-posting.service';
import { PlanAccountResolverService } from '../../revenue-recognition/services/plan-account-resolver.service';

/**
 * Chart-of-accounts code for `4510 Coupon Discount` (contra-revenue,
 * debit-normal). Seeded by TS-080's `seedChartOfAccounts`; the contra
 * entry hits this account on every coupon redemption.
 *
 * Hard-coded here (rather than threaded through config) because the
 * chart of accounts is the authority — admin tooling can flip the row
 * to `active = false`, and the JournalPostingService rejects with
 * `account_inactive` if it ever happens. A change to the code would
 * be a schema migration.
 */
const COUPON_DISCOUNT_ACCOUNT_CODE = '4510';

/**
 * Failure variants from `CouponContraRevenueService.applyCouponRedemption`.
 *
 * Mirrors the Result-shaped pattern from JournalPostingService /
 * SubscriptionRevenueRecognizerService / BookingCommissionRecognizerService
 * (CLAUDE.md §2.1 — fallible cross-boundary ops return Result, never
 * throw). Each variant maps to a controller-side HTTP status:
 *
 *   - `amount_non_positive` → 422 — discount amount is 0 (a zero-value
 *     redemption posts no journal; the upstream service must filter
 *     these before calling).
 *
 *   - `journal_post_failed` → bubbled up from JournalPostingService.
 *     The inner failure carries the specific reason (account_not_found,
 *     period_closed, etc.) so the controller can map each variant to
 *     the right HTTP status.
 */
export type ApplyCouponRedemptionFailure =
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
 * Output of `applyCouponRedemption`. The `result` discriminator
 * distinguishes a fresh post (`'created'`) from an idempotent replay
 * (`'idempotent_replay'`) so the caller can choose whether to suppress
 * retry-side logging.
 */
export interface ApplyCouponRedemptionOutput {
  readonly journalId: string;
  readonly couponRedemptionId: string;
  readonly subscriptionId: string;
  readonly planCode: string;
  readonly discountAmountMinor: number;
  readonly currency: 'USD';
  readonly result: 'created' | 'idempotent_replay';
}

/**
 * `CouponContraRevenueService` — receiver-side of the `coupon.redeemed`
 * event (TS-084, PDD Appendix A, CLAUDE.md §6).
 *
 * One public method: `applyCouponRedemption(request)`. Posts a two-line
 * journal per PDD Appendix A:
 *
 *     DR 4510 Coupon Discount       $discountAmount
 *     CR 4000.{planCode} Subscription Revenue $discountAmount
 *
 * **Why this is contra-revenue, not a refund.** A coupon discount is
 * applied AT INVOICE TIME — the customer paid the post-discount price,
 * and the platform "earned" the gross face value with the discount
 * simultaneously offsetting recognised revenue. PDD Appendix A names
 * this shape explicitly: "Coupon $50 applied to invoice → DR Coupon
 * Discount $50 / CR Subscription Revenue $50". Net income-statement
 * effect is zero (the credit to revenue cancels against the debit to
 * the contra account), but the GROSS figures are reported separately
 * — finance can answer "what would MRR be without promotional
 * discounts?" from ledger primitives.
 *
 * **Idempotency.** The journal post is idempotent on `sourceEventId`
 * (journals.source_event_id UNIQUE → JournalPostingService replays the
 * existing journal on P2002). A redelivery of the same coupon
 * redemption event surfaces as `result: 'idempotent_replay'` with the
 * original journal returned.
 *
 * **No tenant scoping** — accounting rows are not tenant-scoped
 * (CLAUDE.md §6). Row-level checks live in the controller (shared-
 * secret-pinned internal endpoint).
 *
 * **Transaction boundary.** The journal post opens its own
 * `prisma.$transaction` inside `JournalPostingService`. The service
 * has no additional state to mutate (unlike booking-commission's
 * running-balance upsert), so no second transaction layer is needed.
 */
@Injectable()
export class CouponContraRevenueService {
  private readonly logger = new Logger(CouponContraRevenueService.name);

  constructor(
    // PrismaService injected for parity with sibling recognizers (none of
    // the public surface uses it today; reserved for the future
    // application-side audit trail follow-up, e.g. tracking coupon-
    // redemption-to-journal mappings outside the journals.context jsonb).
    private readonly prisma: PrismaService,
    private readonly journals: JournalPostingService,
    private readonly accounts: PlanAccountResolverService,
  ) {
    void this.prisma; // retain for forward-compatibility
  }

  /**
   * Post the two-line coupon contra-revenue journal.
   *
   * Idempotent on `request.sourceEventId` via the journals.source_event_id
   * UNIQUE. The journal-post path returns the existing journal on
   * P2002; we synthesise the `result` discriminator by pre-flighting a
   * journal lookup against the source event id (same approach as
   * booking-commission-recognizer).
   */
  async applyCouponRedemption(
    request: ApplyCouponRedemptionRequest,
  ): Promise<Result<ApplyCouponRedemptionOutput, ApplyCouponRedemptionFailure>> {
    if (request.discountAmountMinor <= 0) {
      return fail({ kind: 'amount_non_positive' });
    }

    // Pre-flight: is the journal already posted under this
    // sourceEventId? If yes, this is a replay — synthesise the
    // `result` discriminator. We need to know this BEFORE calling
    // JournalPostingService.post because its `ok(...)` Result doesn't
    // carry a created-vs-replayed signal.
    const existingJournal = await this.prisma.journal.findUnique({
      where: { sourceEventId: request.sourceEventId },
      select: { id: true },
    });
    const isReplay = existingJournal !== null;

    const { revenueAccountCode } = this.accounts.resolve(request.planCode);
    const description =
      request.description ??
      `Coupon redemption: ${request.couponRedemptionId} on subscription ${request.subscriptionId}`;
    const memo = `coupon ${request.couponRedemptionId} on ${request.subscriptionId}`;
    const currency: 'USD' = request.currency ?? 'USD';

    const postResult = await this.journals.post(
      {
        kind: 'coupon_redemption',
        occurredAt: request.occurredAt,
        sourceEventId: request.sourceEventId,
        description,
        lines: [
          {
            accountCode: COUPON_DISCOUNT_ACCOUNT_CODE,
            debitMinor: request.discountAmountMinor,
            currency,
            memo,
          },
          {
            accountCode: revenueAccountCode,
            creditMinor: request.discountAmountMinor,
            currency,
            memo,
          },
        ],
        context: {
          couponRedemptionId: request.couponRedemptionId,
          subscriptionId: request.subscriptionId,
          customerId: request.customerId,
          customerGroup: request.customerGroup,
          planCode: request.planCode,
          discountAmountMinor: request.discountAmountMinor,
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
        couponRedemptionId: request.couponRedemptionId,
        subscriptionId: request.subscriptionId,
        planCode: request.planCode,
        discountAmountMinor: request.discountAmountMinor,
        journalId: postResult.value.id,
        sourceEventId: request.sourceEventId,
        result,
      },
      isReplay ? 'coupon-contra-revenue.replay' : 'coupon-contra-revenue.applied',
    );

    return ok({
      journalId: postResult.value.id,
      couponRedemptionId: request.couponRedemptionId,
      subscriptionId: request.subscriptionId,
      planCode: request.planCode,
      discountAmountMinor: request.discountAmountMinor,
      currency,
      result,
    });
  }
}

/**
 * Re-exported for tests / DI containers that want to assert on the
 * canonical contra-revenue account code.
 */
export const COUPON_CONTRA_REVENUE_ACCOUNT_CODE = COUPON_DISCOUNT_ACCOUNT_CODE;
