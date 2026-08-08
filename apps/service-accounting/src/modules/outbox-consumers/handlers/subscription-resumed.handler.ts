import { Injectable, Logger } from '@nestjs/common';
import { SUBSCRIPTION_RESUMED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { SubscriptionRevenueRecognizerService } from '../../revenue-recognition/services/subscription-revenue-recognizer.service';

/**
 * Handler for `subscription.resumed` (TS-042-followup-3b2; PDD §11.2;
 * CLAUDE.md §5.3, §6, §17.17).
 *
 * Restarts amortisation for every paused deferred-revenue balance of the
 * subscription, extending each one's `servicePeriodEnd` by the suspended
 * duration. **Posts no journal**, and — because the extension and the
 * paused-time subtraction use the same integer — needs no reversal /
 * replacement pair for the journals already posted before the pause. The
 * full argument lives on
 * `SubscriptionRevenueRecognizerService.resumeRecognition`.
 *
 * **`toStatus` is read and forwarded, never assumed `active`.** Resume
 * clears Stripe's `pause_collection` and adopts whatever status Stripe
 * reports, which is `past_due` when the subscription was paused
 * mid-dunning. Per the TS-042-followup-3b3 decision `past_due` and
 * `unpaid` both KEEP ACCRUING — the platform has already invoiced and
 * may still collect, and halting recognition on a receivable it still
 * expects to realise is a different accounting position from halting it
 * on service not delivered; if it goes bad it becomes a write-off
 * (TS-084), not a retroactive un-recognition. So the field governs the
 * recorded provenance and the log line rather than gating the resume.
 * Whether ENTITLEMENTS stay suspended is a separate, product question
 * answered elsewhere (TS-042-followup-3a2's paused-membership email).
 *
 * **No free text crosses this boundary.** `hasNote` is forwarded; the
 * note itself stays in the owning service's history (CLAUDE.md §3.9,
 * §12).
 *
 * **Idempotency.** SDK dedup on `(consumer_group, event_id)`, plus the
 * recogniser's status guard — a redelivered resume finds the balance
 * already `active` and returns `idempotent_replay` without extending the
 * service period a second time. That guard is the load-bearing one: a
 * double extension would hand the family a free month.
 */
@Injectable()
export class SubscriptionResumedHandler {
  private readonly logger = new Logger(SubscriptionResumedHandler.name);

  constructor(private readonly recognizer: SubscriptionRevenueRecognizerService) {}

  async handle(args: HandleArgs<typeof SUBSCRIPTION_RESUMED>): Promise<void> {
    const { envelope, payload } = args;

    const outcome = await this.recognizer.resumeRecognition({
      subscriptionId: payload.subscriptionId,
      resumedAt: payload.resumedAt,
      sourceEventId: envelope.eventId,
      toStatus: payload.toStatus,
      hasNote: payload.hasNote,
    });

    const detail = {
      eventId: envelope.eventId,
      subscriptionId: payload.subscriptionId,
      customerId: payload.customerId,
      toStatus: payload.toStatus,
      result: outcome.result,
      balanceIds: outcome.balanceIds,
      extendedBySeconds: outcome.extendedBySeconds,
    };

    if (outcome.result === 'no_balance') {
      this.logger.warn(detail, 'outbox.subscription-resumed.no-balance');
      return;
    }
    this.logger.log(detail, 'outbox.subscription-resumed.applied');
  }
}
