import { Injectable, Logger } from '@nestjs/common';
import { STRIPE_PAYMENT_METHOD_CHANGED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import { StripePaymentMethodReconcilerService } from '../stripe-payment-method-reconciler.service';

/**
 * Handler for `stripe.payment_method.changed` (TS-041b-followup-3c; PRD §6.2;
 * PDD §11.1; CLAUDE.md §5.3).
 *
 * Third and last of the relayed-Stripe handlers, and deliberately identical in
 * shape to its two siblings — same `livemode` gate, same delegation, same
 * outcome-as-metric-label. Three copies of one shape beats three variations of
 * three, because the next reader only has to understand it once.
 */
@Injectable()
export class StripePaymentMethodChangedHandler {
  private readonly logger = new Logger(StripePaymentMethodChangedHandler.name);

  constructor(
    private readonly reconciler: StripePaymentMethodReconcilerService,
    private readonly metrics: SubscriptionMetrics,
    private readonly stripeLivemode: boolean,
  ) {}

  async handle(args: HandleArgs<typeof STRIPE_PAYMENT_METHOD_CHANGED>): Promise<void> {
    const { envelope, payload } = args;

    if (payload.livemode !== this.stripeLivemode) {
      this.logger.warn(
        `stripe.payment_method.changed.mode_mismatch ${JSON.stringify({
          eventId: envelope.eventId,
          eventLivemode: payload.livemode,
          serviceLivemode: this.stripeLivemode,
        })} — dropping; this pod's Stripe key is for the other mode`,
      );
      this.metrics.recordStripeReconcile('payment_method', 'mode_mismatch');
      return;
    }

    const outcome = await this.reconciler.reconcile({
      stripePaymentMethodId: payload.stripePaymentMethodId,
      stripeEventId: payload.stripeEventId,
      stripeEventType: payload.stripeEventType,
    });

    this.metrics.recordStripeReconcile('payment_method', outcome.kind);
  }
}
