import { Injectable, Logger } from '@nestjs/common';
import type { MySubscriptionSummary } from '@taste-and-see/contracts';
import { Decimal } from 'decimal.js';

import { PrismaService } from '../../../prisma/prisma.service';

export interface ReadMySubscriptionInput {
  /**
   * The household the caller is acting in, resolved from the token's
   * `tenantScope` by the controller. Part of the lookup predicate, not a
   * check applied afterwards.
   */
  readonly householdId: string;
  readonly requesterUserId: string;
}

/**
 * `MySubscriptionService` — the family's view of their own membership
 * (TS-042-followup-3a3-followup-1a).
 *
 * **The gap this closes.** Nothing on this platform let a family see the
 * plan they are paying for. `POST /api/v1/subscriptions` created one,
 * the admin console could read one, and the family portal had no route
 * at all — so after checkout a household never saw their plan, their
 * renewal date, or the fact that their card had stopped working, except
 * in the dunning emails. `/billing` shipped in
 * TS-042-followup-3a3-followup-1 with a portal button and nothing to say
 * about the plan it manages, precisely because this read did not exist.
 *
 * **Scoped in the predicate**, the TS-124-followup-scoping shape:
 * `WHERE customer_id = :householdId AND customer_group = 'family'`.
 * Matching the group as well as the id is load-bearing —
 * `subscriptions.customer_id`'s target schema depends on the group, so
 * the id alone does not identify a household.
 *
 * **Returns the most relevant row, not the newest one.** A household
 * that cancelled and re-subscribed has more than one, and the one worth
 * showing is the one that is live. Ordering therefore puts non-terminal
 * statuses first and only then falls back to recency: a family whose
 * current membership is `past_due` must not be shown a tidy `canceled`
 * row from last year because it happens to sort first on some other key.
 */
@Injectable()
export class MySubscriptionService {
  private readonly logger = new Logger(MySubscriptionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async read(input: ReadMySubscriptionInput): Promise<MySubscriptionSummary | null> {
    const rows = await this.prisma.subscription.findMany({
      where: {
        customerId: input.householdId,
        customerGroup: 'family',
      },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        billingInterval: true,
        currentPeriodEnd: true,
        trialEnd: true,
        cancelAtPeriodEnd: true,
        dunningAttempts: true,
        dunningGraceUntil: true,
        pauseCollectionResumesAt: true,
        // The row carries no price of its own — the amount charged is
        // the plan's price for the frozen billing interval, which is how
        // every other read on this service derives it.
        plan: {
          select: {
            code: true,
            name: true,
            monthlyPrice: true,
            annualPrice: true,
            currency: true,
          },
        },
      },
    });

    const row = pickCurrent(rows);
    if (row === undefined) {
      this.logger.log(
        { householdId: input.householdId, requesterUserId: input.requesterUserId },
        'my-subscription.read no membership',
      );
      return null;
    }

    // Money stays an integer minor-unit count end to end — no Decimal
    // round-trip and no float, per CLAUDE.md §4.1 / §17.6. Presentation
    // formatting is the portal's job.
    return {
      planCode: row.plan.code,
      planName: row.plan.name,
      status: row.status,
      billingInterval: row.billingInterval,
      unitPriceUsdMinor: decimalToUsdMinor(
        row.billingInterval === 'monthly' ? row.plan.monthlyPrice : row.plan.annualPrice,
      ),
      currency: narrowCurrency(row.plan.currency),
      currentPeriodEnd: row.currentPeriodEnd.toISOString(),
      trialEnd: row.trialEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      paymentTrouble: isInPaymentTrouble(row),
      // Only meaningful while there IS trouble. Surfacing a stale grace
      // deadline on a healthy membership would invent a warning.
      paymentDueBy: isInPaymentTrouble(row) ? (row.dunningGraceUntil?.toISOString() ?? null) : null,
      pauseResumesAt: row.pauseCollectionResumesAt?.toISOString() ?? null,
    };
  }
}

interface CandidateRow {
  readonly status: string;
  readonly dunningAttempts: number;
  readonly dunningGraceUntil: Date | null;
}

/**
 * Money math per CLAUDE.md §4.1 / §17.6 — `Decimal` in, integer minor
 * units out, rounded exactly once. Identical to `subscription.mapper`'s
 * private helper; duplicated rather than exported because widening a
 * mapper's surface to share four lines invites the next caller to reach
 * for the rest of it.
 */
function decimalToUsdMinor(value: Decimal): number {
  return value
    .toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN)
    .mul(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
    .toNumber();
}

/**
 * Narrow the DB-side `currency CHAR(3)` to the contract enum. A row
 * carrying a future currency surfaces a clean 500 rather than passing an
 * unsupported value onto the wire — the same discipline as the
 * subscription and invoice mappers.
 */
function narrowCurrency(value: string): 'USD' {
  if (value !== 'USD') {
    throw new Error(`unsupported currency in subscription row: ${value}`);
  }
  return 'USD';
}

/**
 * Statuses in which a membership is over. A row in one of these is not
 * what a family means by "my plan" while a live row exists alongside it.
 */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/**
 * The first live row by recency, or — when every row is over — the most
 * recent one, so a family who has cancelled still sees what they had
 * rather than an empty page that reads as data loss.
 */
function pickCurrent<T extends CandidateRow>(rows: readonly T[]): T | undefined {
  return rows.find((r) => !TERMINAL_STATUSES.has(r.status)) ?? rows[0];
}

/**
 * "Is something wrong with the payment?" — the question a family is
 * actually asking, answered here rather than left to a portal to infer
 * from a status enum.
 *
 * Both halves are needed. `past_due` / `unpaid` are the statuses Stripe
 * moves the row to, but a failure early in a cycle can leave the row
 * `active` with a non-zero attempt count — and the family has already
 * had an email about it by then. A portal that said "everything's fine"
 * in that window would be contradicting our own outbound mail.
 */
function isInPaymentTrouble(row: CandidateRow): boolean {
  if (row.status === 'past_due' || row.status === 'unpaid') return true;
  return row.dunningAttempts > 0;
}
