import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { DunningService } from '../subscriptions/services/dunning.service';

/**
 * The Stripe invoice events that drive dunning, and the ones that
 * deliberately do not.
 *
 * **`invoice.paid` drives recovery, NOT `invoice.payment_succeeded` — and
 * both are relayed, so choosing between them is the decision here.** For an
 * ordinary card charge Stripe fires both, and `DunningService.recordPaymentSuccess`
 * writes a `subscription_history` row unconditionally, so honouring both would
 * put two rows in a family's audit trail for one payment. `paid` is the
 * strictly more general signal: an invoice settled out of band or from a
 * credit balance raises `paid` with no `payment_succeeded` at all, while every
 * successful card payment that fully settles an invoice raises `paid` too.
 * Firing on `paid` alone therefore covers every settlement exactly once.
 *
 * The converse also matters: a partial payment raises `payment_succeeded`
 * without `paid`, and that invoice is still open — treating it as a recovery
 * would take a subscription out of dunning while money is still owed.
 *
 * `invoice.voided` and `invoice.marked_uncollectible` are not dunning signals
 * either. Uncollectible is the END of a dunning cycle, and the transition out
 * of it belongs to the exhaustion sweep (TS-042-followup-2), which owns the
 * grace-window arithmetic. Two writers of that transition would race.
 */
const DUNNING_TRIGGERS: Readonly<Record<string, 'failure' | 'success'>> = {
  'invoice.payment_failed': 'failure',
  'invoice.paid': 'success',
};

export type DunningBridgeOutcome = 'applied' | 'not_tracked' | 'rejected' | 'skipped';

/**
 * Routes relayed Stripe invoice outcomes into `DunningService`
 * (TS-042-followup-4; PRD §10.3; PDD §11.1; CLAUDE.md §6).
 *
 * **Dunning has existed since TS-042 and has never been driven by an actual
 * payment failure.** `recordPaymentFailure` / `recordPaymentSuccess` were
 * reachable only from tests and admin tooling, so a family whose card was
 * declined stayed `active` on this platform forever while Stripe retried in
 * the background — no grace window, no `past_due`, no dunning email, and
 * nothing anywhere saying the subscription was in trouble. This is the wire
 * that was missing.
 *
 * **Idempotency.** Two layers. The consumer SDK's dedup table stops a
 * redelivery reaching here at all; underneath it, `attemptedAt` is taken from
 * the Stripe event's own clock, not ours, which is exactly the tuple
 * `recordPaymentFailure` deduplicates on (`dunning_last_attempt_at ==
 * attemptedAt`). A replay that slips past the first layer counts the same
 * failure once, not twice — and a double-counted failure is a family pushed
 * toward cancellation a cycle early.
 *
 * **Failure handling splits the same way as its sibling reconcilers.**
 * `stripe_unavailable` throws, so the SDK retries. Every other rejection —
 * the subscription is already canceled, the request was malformed — is
 * terminal: retrying it ten times changes nothing and buries the dead-letter
 * queue's signal.
 */
@Injectable()
export class StripeDunningBridgeService {
  private readonly logger = new Logger(StripeDunningBridgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dunning: DunningService,
  ) {}

  async apply(args: {
    readonly stripeEventType: string;
    readonly stripeEventId: string;
    readonly stripeSubscriptionId: string | null;
    readonly occurredAt: Date;
  }): Promise<DunningBridgeOutcome> {
    const { stripeEventType, stripeEventId, stripeSubscriptionId, occurredAt } = args;

    const trigger = DUNNING_TRIGGERS[stripeEventType];
    if (trigger === undefined || stripeSubscriptionId === null) {
      // Most relayed invoice events are not dunning signals, and a one-off
      // invoice has no subscription to dun. Deliberately unrecorded — see
      // `SubscriptionMetrics.recordDunningBridge`.
      return 'skipped';
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: { id: true },
    });
    if (subscription === null) {
      this.logger.log(
        `stripe.dunning_bridge.not_tracked ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripeSubscriptionId,
        })}`,
      );
      return 'not_tracked';
    }

    const result =
      trigger === 'failure'
        ? await this.dunning.recordPaymentFailure({
            subscriptionId: subscription.id,
            sourceEventId: stripeEventId,
            // Stripe's clock, not ours — this IS the dedup key.
            attemptedAt: occurredAt,
            actorKind: 'system',
          })
        : await this.dunning.recordPaymentSuccess({
            subscriptionId: subscription.id,
            sourceEventId: stripeEventId,
            succeededAt: occurredAt,
            actorKind: 'system',
          });

    if (result.ok) {
      this.logger.log(
        `stripe.dunning_bridge.applied ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          subscriptionId: subscription.id,
          trigger,
        })}`,
      );
      return 'applied';
    }

    if (result.error.reason === 'stripe_unavailable') {
      // Transient. Throwing hands it back to the SDK's retry schedule rather
      // than losing a payment failure to a Stripe blip.
      throw new StripeDunningBridgeUnavailableError(stripeEventId, result.error.cause);
    }

    this.logger.warn(
      `stripe.dunning_bridge.rejected ${JSON.stringify({
        stripeEventId,
        stripeEventType,
        subscriptionId: subscription.id,
        trigger,
        reason: result.error.reason,
      })}`,
    );
    return 'rejected';
  }
}

/** Wraps a transient Stripe failure so the consumer SDK retries the event. */
export class StripeDunningBridgeUnavailableError extends Error {
  constructor(
    readonly stripeEventId: string,
    override readonly cause: unknown,
  ) {
    super(`dunning could not reach Stripe while handling ${stripeEventId}`);
    this.name = 'StripeDunningBridgeUnavailableError';
  }
}
