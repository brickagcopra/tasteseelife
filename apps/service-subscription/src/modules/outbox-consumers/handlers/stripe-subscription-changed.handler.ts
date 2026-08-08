import { Injectable, Logger } from '@nestjs/common';
import { STRIPE_SUBSCRIPTION_CHANGED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import { StripeSubscriptionReconcilerService } from '../stripe-subscription-reconciler.service';

/**
 * Handler for `stripe.subscription.changed` (TS-041b-followup-3a; PDD §11.1;
 * CLAUDE.md §5.3, §6).
 *
 * Thin by design: the event names an object, the reconciler asks Stripe what
 * that object is now and writes the answer. Every judgement — which fields we
 * own, what an unmappable status means, what to do about a subscription we do
 * not track — lives in the reconciler and its pure mapper, where it is
 * testable without a Stripe client.
 *
 * **Live-mode discipline.** A test-mode event is dropped unless this pod is
 * itself pointed at Stripe test mode. Test and live traffic share this pipe,
 * the payload's `livemode` is the only thing that distinguishes them, and a
 * test-mode `customer.subscription.deleted` replayed against production rows
 * would cancel a real family's care. The check is cheap and the failure it
 * prevents is not recoverable by any retry.
 *
 * **Idempotency (CLAUDE.md §5.3).** Two layers: the SDK's
 * `subscription.outbox_consumer_dedup` PK on `(consumer_group, event_id)`,
 * and — the one that survives a truncated dedup table — the fact that
 * reconciliation is a CONVERGING operation. Re-running it against unchanged
 * Stripe state produces `no_change` and writes nothing, including no history
 * row.
 */
@Injectable()
export class StripeSubscriptionChangedHandler {
  private readonly logger = new Logger(StripeSubscriptionChangedHandler.name);

  constructor(
    private readonly reconciler: StripeSubscriptionReconcilerService,
    private readonly metrics: SubscriptionMetrics,
    private readonly stripeLivemode: boolean,
  ) {}

  async handle(args: HandleArgs<typeof STRIPE_SUBSCRIPTION_CHANGED>): Promise<void> {
    const { envelope, payload } = args;

    if (payload.livemode !== this.stripeLivemode) {
      this.logger.warn(
        `stripe.subscription.changed.mode_mismatch ${JSON.stringify({
          eventId: envelope.eventId,
          eventLivemode: payload.livemode,
          serviceLivemode: this.stripeLivemode,
        })} — dropping; this pod's Stripe key is for the other mode`,
      );
      this.metrics.recordStripeReconcile('subscription', 'mode_mismatch');
      return;
    }

    const outcome = await this.reconciler.reconcile({
      stripeSubscriptionId: payload.stripeSubscriptionId,
      stripeEventId: payload.stripeEventId,
      stripeEventType: payload.stripeEventType,
      // The event's clock, not ours — a redelivered event must stamp an
      // out-of-band pause with when we first heard of it, not with now.
      observedAt: new Date(payload.occurredAt),
    });

    this.metrics.recordStripeReconcile('subscription', outcome.kind);
  }
}
