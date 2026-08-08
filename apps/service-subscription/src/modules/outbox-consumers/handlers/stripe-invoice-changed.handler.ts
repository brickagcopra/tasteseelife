import { Injectable, Logger } from '@nestjs/common';
import { STRIPE_INVOICE_CHANGED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import { StripeDunningBridgeService } from '../stripe-dunning-bridge.service';
import { StripeInvoiceReconcilerService } from '../stripe-invoice-reconciler.service';

/**
 * Handler for `stripe.invoice.changed` (TS-041b-followup-3b; PDD §11.1;
 * CLAUDE.md §5.3, §6).
 *
 * Twin of `StripeSubscriptionChangedHandler` and deliberately identical in
 * shape: the same `livemode` gate for the same reason, the same delegation to
 * a reconciler that owns every judgement, the same outcome-as-metric-label.
 * One relayed event class, one handler, one reconciler — a third arrives with
 * TS-041b-followup-3c and should look exactly like these two.
 */
@Injectable()
export class StripeInvoiceChangedHandler {
  private readonly logger = new Logger(StripeInvoiceChangedHandler.name);

  constructor(
    private readonly reconciler: StripeInvoiceReconcilerService,
    private readonly dunningBridge: StripeDunningBridgeService,
    private readonly metrics: SubscriptionMetrics,
    private readonly stripeLivemode: boolean,
  ) {}

  async handle(args: HandleArgs<typeof STRIPE_INVOICE_CHANGED>): Promise<void> {
    const { envelope, payload } = args;

    if (payload.livemode !== this.stripeLivemode) {
      this.logger.warn(
        `stripe.invoice.changed.mode_mismatch ${JSON.stringify({
          eventId: envelope.eventId,
          eventLivemode: payload.livemode,
          serviceLivemode: this.stripeLivemode,
        })} — dropping; this pod's Stripe key is for the other mode`,
      );
      this.metrics.recordStripeReconcile('invoice', 'mode_mismatch');
      return;
    }

    const outcome = await this.reconciler.reconcile({
      stripeInvoiceId: payload.stripeInvoiceId,
      stripeSubscriptionId: payload.stripeSubscriptionId,
      stripeEventId: payload.stripeEventId,
      stripeEventType: payload.stripeEventType,
    });

    this.metrics.recordStripeReconcile('invoice', outcome.kind);

    // TS-042-followup-4 — dunning runs AFTER the invoice row is current, and
    // unconditionally on the reconcile outcome. The two are independent
    // questions: a redelivery whose invoice write was a `no_change` still
    // needs the dunning state machine consulted, and the bridge has its own
    // idempotency (the Stripe event's clock is the dedup key). Gating dunning
    // on `reconciled` would silently drop a payment failure whose invoice
    // happened to be up to date.
    const dunningOutcome = await this.dunningBridge.apply({
      stripeEventType: payload.stripeEventType,
      stripeEventId: payload.stripeEventId,
      stripeSubscriptionId: payload.stripeSubscriptionId,
      occurredAt: new Date(payload.occurredAt),
    });

    if (dunningOutcome !== 'skipped') {
      this.metrics.recordDunningBridge(dunningOutcome);
    }
  }
}
