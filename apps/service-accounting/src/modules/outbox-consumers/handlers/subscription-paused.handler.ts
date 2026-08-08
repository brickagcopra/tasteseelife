import { Injectable, Logger } from '@nestjs/common';
import { SUBSCRIPTION_PAUSED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { SubscriptionRevenueRecognizerService } from '../../revenue-recognition/services/subscription-revenue-recognizer.service';

/**
 * Handler for `subscription.paused` (TS-042-followup-3b2; PDD §11.2;
 * CLAUDE.md §5.3, §6, §17.17).
 *
 * Suspends amortisation for every in-flight deferred-revenue balance of
 * the subscription. **Posts no journal** — a pause changes the schedule
 * on which the deferred balance amortises, not the balance itself, so
 * there is no economic event to record until service resumes.
 *
 * **Why this handler is not just "skip the row in the sweep".**
 * `computeRecognitionDelta` is calendar-driven and deliberately
 * self-healing, so skipping sweeps alone has zero net effect on the
 * books: the first post-resume tick recomputes from the calendar and
 * catches up every paused day in one journal. The pause is only real
 * because `resumeRecognition` extends the service period and the
 * recognition math subtracts the suspended time. See
 * `SubscriptionRevenueRecognizerService.resumeRecognition`.
 *
 * **No free text crosses this boundary.** `subscription.paused` carries
 * `hasReason`, never the reason: on this platform a pause reason is very
 * often a health or bereavement disclosure about a named senior, and an
 * event replicates far wider than the single column it was written into
 * (CLAUDE.md §3.9, §12). The handler forwards the boolean and nothing
 * more.
 *
 * **Idempotency.** Two layers, as with every consumer here: the SDK's
 * `accounting.outbox_consumer_dedup` PK on `(consumer_group, event_id)`,
 * and — should that table be lost — the recogniser's own status guard,
 * which finds the balance already `paused` and returns
 * `idempotent_replay` WITHOUT restamping `pausedAt`. Restamping would
 * silently shorten the suspension and hand the family back days of
 * service they never received.
 *
 * **A subscription with no in-flight balance is a no-op, not a
 * failure.** A balance that has already fully recognised is legitimately
 * pausable with nothing to suspend. Logged at WARN because it is the one
 * silent case — if it appears for a subscription that should still be
 * amortising, the activation event never landed.
 */
@Injectable()
export class SubscriptionPausedHandler {
  private readonly logger = new Logger(SubscriptionPausedHandler.name);

  constructor(private readonly recognizer: SubscriptionRevenueRecognizerService) {}

  async handle(args: HandleArgs<typeof SUBSCRIPTION_PAUSED>): Promise<void> {
    const { envelope, payload } = args;

    const outcome = await this.recognizer.pauseRecognition({
      subscriptionId: payload.subscriptionId,
      pausedAt: payload.pausedAt,
      sourceEventId: envelope.eventId,
      fromStatus: payload.fromStatus,
      hasReason: payload.hasReason,
    });

    const detail = {
      eventId: envelope.eventId,
      subscriptionId: payload.subscriptionId,
      customerId: payload.customerId,
      fromStatus: payload.fromStatus,
      result: outcome.result,
      balanceIds: outcome.balanceIds,
    };

    if (outcome.result === 'no_balance') {
      this.logger.warn(detail, 'outbox.subscription-paused.no-balance');
      return;
    }
    this.logger.log(detail, 'outbox.subscription-paused.applied');
  }
}
