import { Injectable, Logger } from '@nestjs/common';
import type {
  CancelDeferredRevenueRequest,
  RecognizeActivationRequest,
} from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

import type { Prisma } from '../../../../prisma/generated';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  JournalPostingService,
  type PostJournalFailure,
} from '../../journals/services/journal-posting.service';
import { PlanAccountResolverService } from './plan-account-resolver.service';
import { RecognitionMetrics } from './recognition-metrics';
import {
  asOfDailySuffix,
  computeRecognitionDelta,
  decimalToMinor,
  minorToDecimal,
} from './recognition-math';

/**
 * Failure variants from the recognizer surfaces. Each variant maps to
 * a controller-side HTTP status. `Result<T, E>` discriminated union
 * mirrors the pattern from `JournalPostingService` (CLAUDE.md §2.1
 * — fallible operations crossing transaction boundaries use Result,
 * not throw).
 */
export type RecognizeActivationFailure =
  | { readonly kind: 'period_inverted' }
  | { readonly kind: 'amount_non_positive' }
  | {
      readonly kind: 'subscription_period_conflict';
      readonly subscriptionId: string;
      readonly servicePeriodStart: string;
    }
  | { readonly kind: 'journal_post_failed'; readonly failure: PostJournalFailure };

export type CancelDeferredRevenueFailure = {
  readonly kind: 'balance_not_found';
  readonly subscriptionId: string;
  readonly servicePeriodStart: string;
};

/**
 * Every value of the `accounting.deferred_revenue_status` enum. Declared
 * locally rather than imported from the generated Prisma namespace for
 * the same TS-021-followup-2 reason the row projections are hand-written
 * (`@prisma/client` resolves to the root stub during a service's own
 * type-check — see TS-303c2d).
 */
export type DeferredRevenueStatusValue = 'active' | 'fully_recognized' | 'canceled' | 'paused';

/**
 * Slim projection of `DeferredRevenueBalance` consumed by the
 * recognition driver. Kept narrow so the TS-021-followup-2-style
 * Prisma-namespace value-side resolution doesn't bleed in.
 */
interface BalanceForRecognition {
  readonly id: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly planCode: string;
  readonly originalAmount: unknown;
  readonly recognizedAmount: unknown;
  readonly currency: string;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly lastRecognizedAt: Date | null;
  readonly status: DeferredRevenueStatusValue;
  readonly sourceEventId: string;
  readonly pausedDurationSeconds: number;
}

/**
 * Slim projection for the pause / resume paths. Carries the two pause
 * columns plus `servicePeriodEnd` (resume extends it) and `context`
 * (merged, never replaced — the activation context must survive).
 */
interface BalanceForPause {
  readonly id: string;
  readonly subscriptionId: string;
  readonly status: DeferredRevenueStatusValue;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly pausedAt: Date | null;
  readonly pausedDurationSeconds: number;
  readonly context: unknown;
}

/**
 * Slim projection covering the activation idempotent-replay path.
 */
interface ExistingBalanceForActivation {
  readonly id: string;
  readonly subscriptionId: string;
  readonly originalAmount: unknown;
  readonly recognizedAmount: unknown;
  readonly currency: string;
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly status: DeferredRevenueStatusValue;
  readonly activationJournalId: string;
}

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(failure: E): Result<never, E> => ({ ok: false, failure });

export interface RecognizeActivationOutput {
  readonly balanceId: string;
  readonly subscriptionId: string;
  readonly activationJournalId: string;
  readonly originalAmountMinor: number;
  readonly recognizedAmountMinor: number;
  readonly currency: 'USD';
  readonly servicePeriodStart: Date;
  readonly servicePeriodEnd: Date;
  readonly status: DeferredRevenueStatusValue;
  readonly result: 'created' | 'idempotent_replay';
}

export interface CancelDeferredRevenueOutput {
  readonly balanceId: string;
  readonly subscriptionId: string;
  readonly previousStatus: DeferredRevenueStatusValue;
  readonly status: DeferredRevenueStatusValue;
  readonly remainingDeferredMinor: number;
  readonly result: 'canceled' | 'idempotent_replay';
}

/**
 * Input to `pauseRecognition` (TS-042-followup-3b2).
 *
 * Declared here rather than in `@taste-and-see/contracts` on purpose:
 * there is no HTTP surface for pause/resume recognition and no other
 * service calls it. The contracts package carries *public* service
 * contracts (CLAUDE.md §2.3); the only caller is this service's own
 * `subscription.paused` outbox handler, one module away.
 *
 * **No free text.** `subscription.paused` deliberately withholds the
 * pause reason — on this platform it is very often a health or
 * bereavement disclosure about a named senior (CLAUDE.md §3.9, §12) —
 * and this request carries the same `hasReason` boolean and nothing
 * more.
 */
export interface PauseRecognitionRequest {
  readonly subscriptionId: string;
  /** Domain instant the pause took effect (the event's `pausedAt`). */
  readonly pausedAt: string;
  /** Upstream event id, recorded on the balance for ops trace-back. */
  readonly sourceEventId: string;
  /** Dunning status the subscription moved FROM. */
  readonly fromStatus: string;
  /** Whether an operator recorded context worth reading at the source. */
  readonly hasReason: boolean;
}

/**
 * Input to `resumeRecognition` (TS-042-followup-3b2).
 *
 * `toStatus` is carried because `subscription.resumed` does not always
 * mean recovery — a subscription paused mid-dunning resumes to
 * `past_due`. Per the TS-042-followup-3b3 decision `past_due` and
 * `unpaid` both keep accruing (the platform has invoiced and may still
 * collect), so the field governs logging and any future policy split
 * rather than gating the resume — but it is read, recorded and
 * asserted on rather than assumed.
 */
export interface ResumeRecognitionRequest {
  readonly subscriptionId: string;
  /** Domain instant the resume took effect (the event's `resumedAt`). */
  readonly resumedAt: string;
  readonly sourceEventId: string;
  /** Dunning status adopted from Stripe. NOT always `active`. */
  readonly toStatus: string;
  readonly hasNote: boolean;
}

/**
 * Outcome discriminator shared by both pause and resume.
 *
 * `no_balance` is a first-class outcome, not a failure: a subscription
 * whose only balance has already fully recognised is legitimately
 * pausable with nothing to suspend. Modelling it as an error would make
 * the handler throw and the event redeliver forever.
 */
export type RecognitionPauseResult = 'applied' | 'idempotent_replay' | 'no_balance';

export interface PauseRecognitionOutput {
  readonly subscriptionId: string;
  readonly result: RecognitionPauseResult;
  /** Balances suspended by this call (empty on replay / no_balance). */
  readonly balanceIds: readonly string[];
}

export interface ResumeRecognitionOutput {
  readonly subscriptionId: string;
  readonly result: RecognitionPauseResult;
  readonly balanceIds: readonly string[];
  /**
   * Seconds each balance's `servicePeriodEnd` moved out by. Zero when
   * nothing resumed. Non-negative by construction — a `resumedAt`
   * before the recorded `pausedAt` (clock skew, out-of-order delivery)
   * clamps to zero rather than shortening a family's service period.
   */
  readonly extendedBySeconds: number;
}

export interface RecognizeDailyOutput {
  readonly asOf: Date;
  readonly scannedCount: number;
  readonly recognizedCount: number;
  readonly skippedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly totalRecognizedMinor: number;
}

/**
 * Soft cap on rows scanned per `recognizeDaily` invocation. Bounds the
 * sweep so a single call doesn't lock the table for the whole worker
 * lifetime; the BullMQ scheduled worker (TS-082-followup-2) chains
 * pages until the active backlog is drained.
 */
const DEFAULT_SWEEP_BATCH_SIZE = 500;

/**
 * `SubscriptionRevenueRecognizerService` — the revenue-recognition
 * surface (TS-082, PDD §11.2, Appendix A, CLAUDE.md §17.17).
 *
 * Five public methods:
 *
 *   1. `recognizeActivation` — posts the activation journal (DR Cash
 *      / CR Deferred Revenue per-plan) AND creates the balance row in
 *      one transaction. Idempotent on `sourceEventId` at both layers
 *      (the journal's UNIQUE constraint + the balance's UNIQUE
 *      constraint). A redelivery of the same activation event surfaces
 *      as `result: 'idempotent_replay'` with the original journal +
 *      balance returned.
 *
 *   2. `recognizeDaily(asOf)` — sweeps every active balance whose
 *      period has started, computes the cumulative recognition delta,
 *      and posts a `subscription_recognition` journal (DR Deferred
 *      Revenue / CR Subscription Revenue, per-plan) for the delta.
 *      Updates the balance row's `recognizedAmount` + `status` +
 *      `lastRecognizedAt`. Idempotent on per-balance-per-day source
 *      event id; safe to re-run on the same day.
 *
 *   3. `cancelDeferredRevenue` — halts recognition for a balance by
 *      flipping its status to `canceled`. The remaining unrecognised
 *      deferred amount stays on the books until TS-084 ships refund
 *      / write-off handling. Idempotent — replaying a cancel against
 *      an already-canceled balance returns `result: 'idempotent_replay'`.
 *
 *   4. `pauseRecognition` / 5. `resumeRecognition` — suspend and
 *      restart amortisation around a subscription pause
 *      (TS-042-followup-3b2). Neither posts a journal: a pause changes
 *      the *schedule* the deferred balance amortises on, not the
 *      balance. Resume extends `servicePeriodEnd` by the suspended
 *      duration AND accumulates it into `pausedDurationSeconds`, which
 *      the recognition math subtracts from elapsed time — see
 *      `resumeRecognition`'s doc-block for why both halves are
 *      required and why the pair owes no correcting journals.
 *

 * **Per-journal-per-balance idempotency at the application layer.**
 * The cumulative-rounding math means the SAME daily sweep run twice
 * on the same UTC date computes the same delta the second time;
 * combined with the daily source event id format
 * (`subscription.recognized:{subscriptionId}:{YYYY-MM-DD}`), a
 * replayed sweep collapses to no-op at the journal layer. The
 * balance row update is also idempotent — re-applying
 * `recognizedAmount = expectedCumulative` is a no-op when
 * `recognizedAmount` already matches.
 *
 * **Posting + balance update are NOT in a single transaction.** The
 * journal post (`JournalPostingService.post`) opens its own
 * transaction; we sequence balance update after a successful post.
 * The retry path heals via idempotency:
 *   - If the journal post succeeds but the balance update fails, the
 *     next sweep computes a non-zero delta (because the balance row
 *     still says "not recognised yet"), tries to repost the same
 *     journal, gets the existing journal back via the source-event-id
 *     UNIQUE replay, then re-attempts the balance update.
 * Trade-off: a failed sweep run between the post and the update
 * leaves the balance row temporarily out of step with the ledger;
 * the next sweep heals it. This is the right tradeoff because
 * cross-service transactions across two Prisma transactions are
 * fragile and would block on holding the journal-post lock for the
 * full sweep batch.
 */
@Injectable()
export class SubscriptionRevenueRecognizerService {
  private readonly logger = new Logger(SubscriptionRevenueRecognizerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly journals: JournalPostingService,
    private readonly accounts: PlanAccountResolverService,
    /**
     * TS-042-followup-3b2-followup-2. Optional with a default so the
     * three-argument construction used across this service's unit tests
     * keeps working; Nest injects the registered provider in production
     * (the `DunningMetrics` / `KycMetrics` precedent). The default
     * instance writes to an uninitialised meter, which is a no-op — in
     * the running service the provider is constructed after
     * `observability/bootstrap` has already run as `main.ts`'s first
     * import.
     */
    private readonly metrics: RecognitionMetrics = new RecognitionMetrics(),
  ) {}

  /**
   * Post the activation journal + create the deferred-revenue
   * balance row in a single transaction.
   */
  async recognizeActivation(
    request: RecognizeActivationRequest,
  ): Promise<Result<RecognizeActivationOutput, RecognizeActivationFailure>> {
    const servicePeriodStart = new Date(request.servicePeriodStart);
    const servicePeriodEnd = new Date(request.servicePeriodEnd);

    if (servicePeriodStart >= servicePeriodEnd) {
      return fail({ kind: 'period_inverted' });
    }
    if (request.amountMinor <= 0) {
      return fail({ kind: 'amount_non_positive' });
    }

    // Idempotent-replay path: look up the existing balance by the
    // upstream source event id. If found, return without re-posting.
    const existingBySource = await this.prisma.deferredRevenueBalance.findUnique({
      where: { sourceEventId: request.sourceEventId },
      select: EXISTING_BALANCE_FOR_ACTIVATION_SELECT,
    });
    if (existingBySource !== null) {
      const replay = existingBySource as ExistingBalanceForActivation;
      this.logger.log(
        {
          subscriptionId: replay.subscriptionId,
          balanceId: replay.id,
          sourceEventId: request.sourceEventId,
        },
        'revenue-recognition.activation.replay',
      );
      return ok(this.toActivationOutput(replay, 'idempotent_replay'));
    }

    // Confirm there's no conflicting row for the same (subscription,
    // period start). The composite UNIQUE will fail-fast at insert
    // time too, but a clean 422 with the offending pair beats a P2002.
    const conflict = await this.prisma.deferredRevenueBalance.findUnique({
      where: {
        subscription_period_unique: {
          subscriptionId: request.subscriptionId,
          servicePeriodStart,
        },
      },
      select: { id: true, sourceEventId: true },
    });
    if (conflict !== null && conflict.sourceEventId !== request.sourceEventId) {
      return fail({
        kind: 'subscription_period_conflict',
        subscriptionId: request.subscriptionId,
        servicePeriodStart: request.servicePeriodStart,
      });
    }

    const { deferredAccountCode } = this.accounts.resolve(request.planCode);
    const cashAccountCode = '1000';
    const occurredAt = request.occurredAt;
    const description =
      request.description ??
      `Subscription activation: ${request.subscriptionId} (${request.planCode})`;
    const memo = `subscription ${request.subscriptionId} (${request.planCode})`;

    // Post the activation journal FIRST. The service-layer
    // `source_event_id` UNIQUE makes the redelivery path safe.
    const postResult = await this.journals.post(
      {
        kind: 'subscription_activation',
        occurredAt,
        sourceEventId: request.sourceEventId,
        description,
        lines: [
          {
            accountCode: cashAccountCode,
            debitMinor: request.amountMinor,
            currency: 'USD',
            memo,
          },
          {
            accountCode: deferredAccountCode,
            creditMinor: request.amountMinor,
            currency: 'USD',
            memo,
          },
        ],
        context: {
          subscriptionId: request.subscriptionId,
          customerId: request.customerId,
          customerGroup: request.customerGroup,
          planCode: request.planCode,
          servicePeriodStart: request.servicePeriodStart,
          servicePeriodEnd: request.servicePeriodEnd,
          ...(request.context ?? {}),
        },
      },
      null,
    );
    if (!postResult.ok) {
      return fail({ kind: 'journal_post_failed', failure: postResult.failure });
    }

    // Persist the balance row. Composite UNIQUE on
    // (subscription_id, service_period_start) defends against a
    // race; if we lose the race, refetch the winner.
    const originalAmountDecimal = minorToDecimal(request.amountMinor);
    let created;
    try {
      created = await this.prisma.deferredRevenueBalance.create({
        data: {
          subscriptionId: request.subscriptionId,
          customerId: request.customerId,
          customerGroup: request.customerGroup,
          planCode: request.planCode,
          originalAmount: originalAmountDecimal,
          recognizedAmount: new Decimal(0),
          currency: request.currency ?? 'USD',
          servicePeriodStart,
          servicePeriodEnd,
          status: 'active',
          activationJournalId: postResult.value.id,
          sourceEventId: request.sourceEventId,
          // Non-nullable `Json` column — see the note in
          // journal-posting.service.ts. The nested `stripeContext` is a
          // `Record<string, unknown>`, which is what blocks structural
          // assignment to `InputJsonValue` (TS-501).
          context: {
            stripeContext: request.context ?? {},
            planCode: request.planCode,
            customerGroup: request.customerGroup,
          } as Prisma.InputJsonValue,
        },
        select: EXISTING_BALANCE_FOR_ACTIVATION_SELECT,
      });
    } catch (err) {
      // Race against a concurrent activation — UNIQUE either on
      // source_event_id or on (subscription, period start) means we
      // lost; refetch the winner via the source_event_id index.
      if (isPrismaUniqueViolation(err)) {
        const winner = await this.prisma.deferredRevenueBalance.findUnique({
          where: { sourceEventId: request.sourceEventId },
          select: EXISTING_BALANCE_FOR_ACTIVATION_SELECT,
        });
        if (winner !== null) {
          this.logger.log(
            {
              subscriptionId: request.subscriptionId,
              balanceId: winner.id,
              sourceEventId: request.sourceEventId,
            },
            'revenue-recognition.activation.race-replay',
          );
          return ok(
            this.toActivationOutput(winner as ExistingBalanceForActivation, 'idempotent_replay'),
          );
        }
      }
      throw err;
    }

    const persisted = created as ExistingBalanceForActivation;
    this.logger.log(
      {
        subscriptionId: persisted.subscriptionId,
        balanceId: persisted.id,
        activationJournalId: persisted.activationJournalId,
        amountMinor: request.amountMinor,
        planCode: request.planCode,
      },
      'revenue-recognition.activation.created',
    );
    return ok(this.toActivationOutput(persisted, 'created'));
  }

  /**
   * Halt recognition for the (subscription, periodStart) balance.
   *
   * Marks the row as `canceled`. The remaining deferred amount
   * stays on the books — TS-084 will ship the contra-revenue +
   * refund handling. Idempotent: a replay returns the existing row
   * with `result: 'idempotent_replay'`.
   */
  async cancelDeferredRevenue(
    request: CancelDeferredRevenueRequest,
  ): Promise<Result<CancelDeferredRevenueOutput, CancelDeferredRevenueFailure>> {
    const servicePeriodStart = new Date(request.servicePeriodStart);

    const existing = await this.prisma.deferredRevenueBalance.findUnique({
      where: {
        subscription_period_unique: {
          subscriptionId: request.subscriptionId,
          servicePeriodStart,
        },
      },
      select: BALANCE_FOR_CANCEL_SELECT,
    });
    if (existing === null) {
      return fail({
        kind: 'balance_not_found',
        subscriptionId: request.subscriptionId,
        servicePeriodStart: request.servicePeriodStart,
      });
    }

    const previousStatus = existing.status;
    const originalAmount = asDecimal(existing.originalAmount);
    const recognizedAmount = asDecimal(existing.recognizedAmount);
    const remainingDeferred = originalAmount.sub(recognizedAmount);
    const remainingDeferredMinor = decimalToMinor(remainingDeferred);

    if (previousStatus === 'canceled') {
      this.logger.log(
        {
          subscriptionId: existing.subscriptionId,
          balanceId: existing.id,
          sourceEventId: request.sourceEventId,
        },
        'revenue-recognition.cancel.replay',
      );
      return ok({
        balanceId: existing.id,
        subscriptionId: existing.subscriptionId,
        previousStatus,
        status: 'canceled',
        remainingDeferredMinor,
        result: 'idempotent_replay',
      });
    }

    await this.prisma.deferredRevenueBalance.update({
      where: { id: existing.id },
      data: {
        status: 'canceled',
        context: {
          canceledAt: request.occurredAt,
          cancelSourceEventId: request.sourceEventId,
          ...(request.reason !== undefined ? { cancelReason: request.reason } : {}),
        },
      },
    });
    this.logger.log(
      {
        subscriptionId: existing.subscriptionId,
        balanceId: existing.id,
        sourceEventId: request.sourceEventId,
        previousStatus,
        remainingDeferredMinor,
      },
      'revenue-recognition.cancel.applied',
    );

    return ok({
      balanceId: existing.id,
      subscriptionId: existing.subscriptionId,
      previousStatus,
      status: 'canceled',
      remainingDeferredMinor,
      result: 'canceled',
    });
  }

  /**
   * Suspend recognition for every in-flight balance of a subscription
   * (TS-042-followup-3b2).
   *
   * Flips `active` → `paused` and stamps `pausedAt`. The daily sweep
   * filters `status: 'active'`, so a paused balance drops out of
   * amortisation for free.
   *
   * **Idempotent on status, not on event id.** A redelivered pause
   * finds the row already `paused` and returns without touching
   * `pausedAt` — overwriting it would silently shorten the suspension
   * and hand the family back days of service they did not receive.
   *
   * **Posts no journal.** A pause changes the *schedule* on which the
   * deferred balance amortises, not the balance itself; there is no
   * economic event to record until service resumes.
   */
  async pauseRecognition(request: PauseRecognitionRequest): Promise<PauseRecognitionOutput> {
    const pausedAt = new Date(request.pausedAt);
    const rows = (await this.prisma.deferredRevenueBalance.findMany({
      where: {
        subscriptionId: request.subscriptionId,
        status: { in: ['active', 'paused'] },
      },
      select: BALANCE_FOR_PAUSE_SELECT,
      orderBy: [{ servicePeriodStart: 'asc' }, { id: 'asc' }],
    })) as BalanceForPause[];

    const active = rows.filter((row) => row.status === 'active');
    if (active.length === 0) {
      const result: RecognitionPauseResult = rows.length > 0 ? 'idempotent_replay' : 'no_balance';
      return this.finishPause(result, [], {
        subscriptionId: request.subscriptionId,
        sourceEventId: request.sourceEventId,
      });
    }

    for (const row of active) {
      await this.prisma.deferredRevenueBalance.update({
        where: { id: row.id },
        data: {
          status: 'paused',
          pausedAt,
          context: mergeContext(row.context, {
            pause: {
              pausedAt: request.pausedAt,
              sourceEventId: request.sourceEventId,
              fromStatus: request.fromStatus,
              hasReason: request.hasReason,
            },
          }),
        },
      });
    }

    return this.finishPause(
      'applied',
      active.map((row) => row.id),
      {
        subscriptionId: request.subscriptionId,
        sourceEventId: request.sourceEventId,
        pausedAt: request.pausedAt,
        fromStatus: request.fromStatus,
        hasReason: request.hasReason,
      },
    );
  }

  /**
   * Single exit for `pauseRecognition`: log, meter and return, in that
   * order, for every outcome.
   *
   * Funnelling all three arms through one helper is the point — a new
   * outcome cannot ship with only two of log / meter / return, which is
   * exactly how TS-042-followup-3b2 shipped with logs and no metric.
   */
  private finishPause(
    result: RecognitionPauseResult,
    balanceIds: readonly string[],
    detail: Readonly<Record<string, unknown>>,
  ): PauseRecognitionOutput {
    const subscriptionId = String(detail['subscriptionId']);
    this.logger.log(
      { ...detail, result, balanceIds },
      result === 'applied'
        ? 'revenue-recognition.pause.applied'
        : 'revenue-recognition.pause.no-op',
    );
    this.metrics.record('pause', result);
    return { subscriptionId, result, balanceIds };
  }

  /**
   * Restart recognition for every paused balance of a subscription
   * (TS-042-followup-3b2).
   *
   * **Extends `servicePeriodEnd` by the suspended duration and
   * accumulates it into `pausedDurationSeconds`.** Both halves are
   * required and neither works alone:
   *
   *   - Extending alone enlarges the denominator but leaves the paused
   *     days in the elapsed numerator, so the first post-resume sweep
   *     still posts a catch-up journal for service never delivered.
   *   - Subtracting alone would amortise `originalAmount` over less
   *     than the full period, stranding a remainder at the end.
   *
   * Applying the *same integer* to both keeps the effective denominator
   * `(end - start) - paused` identical to the original service
   * duration. That is what makes the first post-resume sweep compute a
   * cumulative equal to what was already recognised at the pause (delta
   * zero — recognition picks up exactly where it stopped) and what
   * makes every journal posted before the pause still correct, so this
   * change owes no reversal / replacement pair (CLAUDE.md §6, §17.7).
   *
   * **`toStatus` is read, never assumed `active`.** Per the
   * TS-042-followup-3b3 decision `past_due` and `unpaid` both keep
   * accruing — the platform has already invoiced and may still collect,
   * and halting recognition on a receivable it still expects to realise
   * is a different accounting position from halting it on service not
   * delivered. If it ultimately goes bad it is a write-off (TS-084),
   * not a retroactive un-recognition. The status is therefore recorded
   * and logged rather than used as a gate.
   */
  async resumeRecognition(request: ResumeRecognitionRequest): Promise<ResumeRecognitionOutput> {
    const resumedAt = new Date(request.resumedAt);
    const rows = (await this.prisma.deferredRevenueBalance.findMany({
      where: {
        subscriptionId: request.subscriptionId,
        status: { in: ['active', 'paused'] },
      },
      select: BALANCE_FOR_PAUSE_SELECT,
      orderBy: [{ servicePeriodStart: 'asc' }, { id: 'asc' }],
    })) as BalanceForPause[];

    const paused = rows.filter((row) => row.status === 'paused');
    if (paused.length === 0) {
      const result: RecognitionPauseResult = rows.length > 0 ? 'idempotent_replay' : 'no_balance';
      return this.finishResume(result, [], 0, {
        subscriptionId: request.subscriptionId,
        sourceEventId: request.sourceEventId,
        toStatus: request.toStatus,
      });
    }

    let extendedBySeconds = 0;
    for (const row of paused) {
      const rawSeconds = suspendedDurationSeconds(row.pausedAt, resumedAt);
      const suspendedSeconds = rawSeconds < 0 ? 0 : rawSeconds;
      if (rawSeconds < 0) {
        // `resumedAt` before the recorded `pausedAt` — clock skew
        // between the producer's two writes, or a row paused by a later
        // event than the one this resume answers. Clamping to zero
        // resumes accrual on the original schedule; the alternative
        // (a negative extension) would shorten a family's service
        // period by the skew.
        this.logger.warn(
          {
            subscriptionId: request.subscriptionId,
            balanceId: row.id,
            pausedAt: row.pausedAt?.toISOString() ?? null,
            resumedAt: request.resumedAt,
          },
          'revenue-recognition.resume.negative-duration-clamped',
        );
      }
      extendedBySeconds = suspendedSeconds;
      await this.prisma.deferredRevenueBalance.update({
        where: { id: row.id },
        data: {
          status: 'active',
          pausedAt: null,
          pausedDurationSeconds: row.pausedDurationSeconds + suspendedSeconds,
          servicePeriodEnd: new Date(
            row.servicePeriodEnd.getTime() + suspendedSeconds * MS_PER_SECOND,
          ),
          context: mergeContext(row.context, {
            resume: {
              resumedAt: request.resumedAt,
              sourceEventId: request.sourceEventId,
              toStatus: request.toStatus,
              hasNote: request.hasNote,
              extendedBySeconds: suspendedSeconds,
            },
          }),
        },
      });
    }

    return this.finishResume(
      'applied',
      paused.map((row) => row.id),
      extendedBySeconds,
      {
        subscriptionId: request.subscriptionId,
        sourceEventId: request.sourceEventId,
        resumedAt: request.resumedAt,
        toStatus: request.toStatus,
        hasNote: request.hasNote,
      },
    );
  }

  /** Single exit for `resumeRecognition`. See `finishPause`. */
  private finishResume(
    result: RecognitionPauseResult,
    balanceIds: readonly string[],
    extendedBySeconds: number,
    detail: Readonly<Record<string, unknown>>,
  ): ResumeRecognitionOutput {
    const subscriptionId = String(detail['subscriptionId']);
    this.logger.log(
      { ...detail, result, balanceIds, extendedBySeconds },
      result === 'applied'
        ? 'revenue-recognition.resume.applied'
        : 'revenue-recognition.resume.no-op',
    );
    this.metrics.record('resume', result);
    return { subscriptionId, result, balanceIds, extendedBySeconds };
  }

  /**
   * Sweep every active balance whose period has started, posting
   * `subscription_recognition` journals for any pending delta and
   * updating the balance row's `recognizedAmount` + `status`.
   */
  async recognizeDaily(
    asOf: Date,
    batchSize: number = DEFAULT_SWEEP_BATCH_SIZE,
  ): Promise<RecognizeDailyOutput> {
    const balances = (await this.prisma.deferredRevenueBalance.findMany({
      where: {
        status: 'active',
        servicePeriodStart: { lte: asOf },
      },
      select: BALANCE_FOR_RECOGNITION_SELECT,
      orderBy: [{ servicePeriodStart: 'asc' }, { id: 'asc' }],
      take: batchSize,
    })) as BalanceForRecognition[];

    let scanned = 0;
    let recognized = 0;
    let skipped = 0;
    let completed = 0;
    let failed = 0;
    let totalRecognizedMinor = 0;

    for (const balance of balances) {
      scanned += 1;
      const originalAmount = asDecimal(balance.originalAmount);
      const alreadyRecognized = asDecimal(balance.recognizedAmount);

      const { delta, expectedCumulative, isFinalRecognition, hasRecognitionDue } =
        computeRecognitionDelta({
          originalAmount,
          alreadyRecognized,
          servicePeriodStart: balance.servicePeriodStart,
          servicePeriodEnd: balance.servicePeriodEnd,
          asOf,
          // Suspended time never amortises (TS-042-followup-3b2). Zero
          // for a balance that has never been paused, which is every
          // row predating that migration.
          pausedDurationMs: balance.pausedDurationSeconds * MS_PER_SECOND,
        });

      if (!hasRecognitionDue && !isFinalRecognition) {
        skipped += 1;
        continue;
      }

      // Even when `hasRecognitionDue` is false but isFinalRecognition
      // is true, we still want to flip status to `fully_recognized`
      // if the balance is already at original (e.g. a manual
      // adjustment pre-recognised everything). Handle the post-flip
      // path:
      if (!hasRecognitionDue && isFinalRecognition) {
        await this.prisma.deferredRevenueBalance.update({
          where: { id: balance.id },
          data: {
            status: 'fully_recognized',
            lastRecognizedAt: asOf,
          },
        });
        completed += 1;
        continue;
      }

      const { deferredAccountCode, revenueAccountCode } = this.accounts.resolve(balance.planCode);
      const deltaMinor = decimalToMinor(delta);
      const dailySuffix = asOfDailySuffix(asOf);
      const sourceEventId = `subscription.recognized:${balance.subscriptionId}:${dailySuffix}`;
      const memo = `subscription ${balance.subscriptionId} (${balance.planCode}) ${dailySuffix}`;

      const postResult = await this.journals.post(
        {
          kind: 'subscription_recognition',
          occurredAt: asOf.toISOString(),
          sourceEventId,
          description: `Daily recognition for ${balance.subscriptionId} (${balance.planCode}) ${dailySuffix}`,
          lines: [
            {
              accountCode: deferredAccountCode,
              debitMinor: deltaMinor,
              currency: 'USD',
              memo,
            },
            {
              accountCode: revenueAccountCode,
              creditMinor: deltaMinor,
              currency: 'USD',
              memo,
            },
          ],
          context: {
            subscriptionId: balance.subscriptionId,
            customerId: balance.customerId,
            planCode: balance.planCode,
            servicePeriodStart: balance.servicePeriodStart.toISOString(),
            servicePeriodEnd: balance.servicePeriodEnd.toISOString(),
            isFinalRecognition,
          },
        },
        null,
      );

      if (!postResult.ok) {
        failed += 1;
        this.logger.error(
          {
            balanceId: balance.id,
            subscriptionId: balance.subscriptionId,
            failure: postResult.failure,
          },
          'revenue-recognition.daily.post-failed',
        );
        continue;
      }

      // Update balance row to the new cumulative. The next sweep
      // computes 0 delta on this row (idempotent same-day re-run).
      await this.prisma.deferredRevenueBalance.update({
        where: { id: balance.id },
        data: {
          recognizedAmount: expectedCumulative,
          lastRecognizedAt: asOf,
          status: isFinalRecognition ? 'fully_recognized' : 'active',
        },
      });

      recognized += 1;
      if (isFinalRecognition) {
        completed += 1;
      }
      totalRecognizedMinor += deltaMinor;
    }

    this.logger.log(
      {
        asOf: asOf.toISOString(),
        scanned,
        recognized,
        skipped,
        completed,
        failed,
        totalRecognizedMinor,
      },
      'revenue-recognition.daily.swept',
    );

    return {
      asOf,
      scannedCount: scanned,
      recognizedCount: recognized,
      skippedCount: skipped,
      completedCount: completed,
      failedCount: failed,
      totalRecognizedMinor,
    };
  }

  private toActivationOutput(
    persisted: ExistingBalanceForActivation,
    result: 'created' | 'idempotent_replay',
  ): RecognizeActivationOutput {
    const originalDecimal = asDecimal(persisted.originalAmount);
    const recognizedDecimal = asDecimal(persisted.recognizedAmount);
    return {
      balanceId: persisted.id,
      subscriptionId: persisted.subscriptionId,
      activationJournalId: persisted.activationJournalId,
      originalAmountMinor: decimalToMinor(originalDecimal),
      recognizedAmountMinor: decimalToMinor(recognizedDecimal),
      currency: narrowCurrency(persisted.currency),
      servicePeriodStart: persisted.servicePeriodStart,
      servicePeriodEnd: persisted.servicePeriodEnd,
      status: persisted.status,
      result,
    };
  }
}

/**
 * Convert Prisma's runtime Decimal (or any decimal-string-compatible
 * value) into a `decimal.js` instance. Prisma's Decimal class is
 * structurally compatible at the `.toString()` level.
 */
function asDecimal(value: unknown): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return new Decimal(value);
  }
  throw new Error(`revenue-recognition: unexpected non-Decimal value: ${String(value)}`);
}

function narrowCurrency(value: string): 'USD' {
  if (value !== 'USD') {
    throw new Error(`revenue-recognition: unsupported currency on persisted balance: ${value}`);
  }
  return 'USD';
}

function isPrismaUniqueViolation(err: unknown): boolean {
  // Duck-typed Prisma error narrowing — TS-021-followup-2 captures
  // the cleanup to the canonical `instanceof
  // Prisma.PrismaClientKnownRequestError` check once the namespace
  // value-side resolves cleanly on the Prisma minor bump.
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; name?: unknown };
  return candidate.code === 'P2002' && candidate.name === 'PrismaClientKnownRequestError';
}

const EXISTING_BALANCE_FOR_ACTIVATION_SELECT = {
  id: true,
  subscriptionId: true,
  originalAmount: true,
  recognizedAmount: true,
  currency: true,
  servicePeriodStart: true,
  servicePeriodEnd: true,
  status: true,
  activationJournalId: true,
} as const;

const BALANCE_FOR_CANCEL_SELECT = {
  id: true,
  subscriptionId: true,
  status: true,
  originalAmount: true,
  recognizedAmount: true,
} as const;

const BALANCE_FOR_RECOGNITION_SELECT = {
  id: true,
  subscriptionId: true,
  customerId: true,
  planCode: true,
  originalAmount: true,
  recognizedAmount: true,
  currency: true,
  servicePeriodStart: true,
  servicePeriodEnd: true,
  lastRecognizedAt: true,
  status: true,
  sourceEventId: true,
  pausedDurationSeconds: true,
} as const;

const BALANCE_FOR_PAUSE_SELECT = {
  id: true,
  subscriptionId: true,
  status: true,
  servicePeriodStart: true,
  servicePeriodEnd: true,
  pausedAt: true,
  pausedDurationSeconds: true,
  context: true,
} as const;

/** Milliseconds in a second. Named so the `* 1000` reads as a unit conversion. */
const MS_PER_SECOND = 1_000;

/**
 * Whole seconds a balance spent suspended, from its recorded
 * `pausedAt` to the resume instant. Truncated (not rounded) so the
 * extension applied to `servicePeriodEnd` and the amount accumulated
 * into `pausedDurationSeconds` are the same integer — the invariant
 * that keeps the effective amortisation denominator equal to the
 * original service duration.
 *
 * A null `pausedAt` yields `0`: the row is marked paused but predates
 * the column, so there is no suspension to compensate for and the
 * honest answer is to resume on the original schedule.
 *
 * May return a NEGATIVE value; the caller clamps and warns rather than
 * having this helper hide the skew.
 */
function suspendedDurationSeconds(pausedAt: Date | null, resumedAt: Date): number {
  if (pausedAt === null) return 0;
  return Math.trunc((resumedAt.getTime() - pausedAt.getTime()) / MS_PER_SECOND);
}

/**
 * Merge a patch into a balance row's `context` JSON without dropping
 * what is already there.
 *
 * The cancel path replaces `context` wholesale; pause/resume must not,
 * because the activation context (Stripe invoice id, plan code,
 * customer group) is the only place some of that provenance is
 * recorded and a pause is not a reason to lose it. A non-object stored
 * value is replaced rather than spread — `{...null}` is silently `{}`
 * and would hide a corrupt row.
 */
function mergeContext(existing: unknown, patch: Record<string, unknown>): Prisma.InputJsonValue {
  const base =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  return { ...base, ...patch } as Prisma.InputJsonValue;
}

// Mark unused interface alias so future select extensions can lift the
// shape without TS erroring.
export type DeferredRevenueBalanceForRecognition = BalanceForRecognition;

// Helper to expose the default sweep batch size to tests + callers
// without exposing the variable directly.
export const DEFAULT_DAILY_SWEEP_BATCH_SIZE = DEFAULT_SWEEP_BATCH_SIZE;

/**
 * Re-exported for tests / DI containers that want to assert on the
 * `subscription_period_unique` compound key shape.
 */
export type SubscriptionPeriodKey = {
  readonly subscriptionId: string;
  readonly servicePeriodStart: Date;
};

/**
 * Convenience constructor for the compound key.
 */
export function buildSubscriptionPeriodKey(
  subscriptionId: string,
  servicePeriodStart: Date,
): SubscriptionPeriodKey {
  return { subscriptionId, servicePeriodStart };
}

// Internal exports needed by the controller / tests but not by the
// public service surface.
export const RecognizerInternal = {
  EXISTING_BALANCE_FOR_ACTIVATION_SELECT,
  BALANCE_FOR_CANCEL_SELECT,
  BALANCE_FOR_RECOGNITION_SELECT,
  BALANCE_FOR_PAUSE_SELECT,
} as const;
