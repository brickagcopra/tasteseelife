import { Injectable } from '@nestjs/common';
import {
  SUBSCRIPTION_DUNNING_EXHAUSTED,
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_PAYMENT_SUCCEEDED,
  SubscriptionDunningExhaustedSchema,
  SubscriptionPaymentFailedSchema,
  SubscriptionPaymentSucceededSchema,
} from '@taste-and-see/contracts';

import { DunningLadderService, type DunningDispatchOutcome } from '../dunning-ladder.service';
import {
  rungForDunningExhausted,
  rungForPaymentFailed,
  rungForPaymentSucceeded,
} from '../dunning-rung';

/**
 * The three outbox handlers behind the dunning ladder (TS-042-followup-3a2).
 *
 * They are deliberately thin: parse, pick the rung, hand to the ladder. All
 * three share one file because they share one shape, and splitting them
 * would put three near-identical eight-line classes in three files.
 *
 * **The payload is re-parsed here even though the relay validated it on the
 * way out.** The producer and this consumer are separate deploys; a skew in
 * which the producer has not yet been updated is exactly when a required
 * field is missing, and a Zod failure that throws is redelivered rather than
 * acted on with an undefined (TS-042-followup-3a2a made `customerGroup`
 * required precisely so this parse would catch it).
 */

/** What the SDK hands a handler. Narrowed to what these three read. */
export interface OutboxHandlerArgs {
  readonly payload: unknown;
}

@Injectable()
export class SubscriptionPaymentFailedHandler {
  constructor(private readonly ladder: DunningLadderService) {}

  async handle(args: OutboxHandlerArgs): Promise<DunningDispatchOutcome> {
    const event = SubscriptionPaymentFailedSchema.parse(args.payload);
    return this.ladder.deliver({
      rung: rungForPaymentFailed(event, this.ladder.templateConfig),
      eventId: event.eventId,
      eventName: SUBSCRIPTION_PAYMENT_FAILED,
      customerId: event.customerId,
      customerGroup: event.customerGroup,
      subscriptionId: event.subscriptionId,
    });
  }
}

@Injectable()
export class SubscriptionPaymentSucceededHandler {
  constructor(private readonly ladder: DunningLadderService) {}

  async handle(args: OutboxHandlerArgs): Promise<DunningDispatchOutcome> {
    const event = SubscriptionPaymentSucceededSchema.parse(args.payload);
    return this.ladder.deliver({
      // `recovered === false` returns a skip here, before any recipient is
      // resolved — a routine renewal must not even cost a household lookup,
      // and it is by far the highest-volume event of the three.
      rung: rungForPaymentSucceeded(event, this.ladder.templateConfig),
      eventId: event.eventId,
      eventName: SUBSCRIPTION_PAYMENT_SUCCEEDED,
      customerId: event.customerId,
      customerGroup: event.customerGroup,
      subscriptionId: event.subscriptionId,
    });
  }
}

@Injectable()
export class SubscriptionDunningExhaustedHandler {
  constructor(private readonly ladder: DunningLadderService) {}

  async handle(args: OutboxHandlerArgs): Promise<DunningDispatchOutcome> {
    const event = SubscriptionDunningExhaustedSchema.parse(args.payload);
    return this.ladder.deliver({
      rung: rungForDunningExhausted(event, this.ladder.templateConfig),
      eventId: event.eventId,
      eventName: SUBSCRIPTION_DUNNING_EXHAUSTED,
      customerId: event.customerId,
      customerGroup: event.customerGroup,
      subscriptionId: event.subscriptionId,
    });
  }
}
