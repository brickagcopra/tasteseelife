import { Inject, Injectable, Logger } from '@nestjs/common';
import { SUBSCRIPTION_PAUSED, SUBSCRIPTION_RESUMED } from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import Stripe from 'stripe';

import { PrismaService, type PrismaTransactionClient } from '../../prisma/prisma.service';
import { STRIPE_SDK_TOKEN } from '../stripe/stripe.constants';
import {
  StripeSubscriptionShapeError,
  changedFields,
  historyEventForStatus,
  mapStripeSubscription,
  type ReconcilableSubscriptionFields,
} from './stripe-subscription-mapping';

/**
 * Why a reconciliation ended the way it did. Every arm is a real,
 * distinguishable operational condition; the handler turns these into one
 * metric label each rather than into a boolean, because "we did nothing" has
 * four causes here and three of them want a human eventually.
 */
export type ReconcileOutcome =
  /** Local row updated; `changed` names the fields that moved. */
  | { readonly kind: 'reconciled'; readonly changed: readonly string[] }
  /** Fetched successfully and every field already agreed — the redelivery case. */
  | { readonly kind: 'no_change' }
  /** No local row for this `sub_...`. Not an error; see the doc-block. */
  | { readonly kind: 'not_tracked' }
  /** Stripe no longer has the subscription our row points at. */
  | { readonly kind: 'stripe_missing' }
  /** Stripe reported a status this platform has no value for. */
  | { readonly kind: 'unknown_status'; readonly stripeStatus: string };

/**
 * Brings a local `subscriptions` row back into step with Stripe
 * (TS-041b-followup-3a; PDD §11.1; CLAUDE.md §6).
 *
 * **The event is a notification; Stripe is the source of truth.** The relayed
 * `stripe.subscription.changed` payload carries only the `sub_...` handle
 * (see `packages/contracts/src/events/stripe-billing.ts` for why), so this
 * service re-fetches. That is not a workaround for a thin payload — it is the
 * property that makes the whole path correct: Stripe does not order webhook
 * delivery, and a re-fetch always yields current state, so a redelivered or
 * out-of-order event CONVERGES on the truth instead of writing an older
 * snapshot over a newer one.
 *
 * **A subscription we do not track is a no-op, not an error.** Platform
 * subscriptions are created through this service, which writes the local row
 * with a `customerId`, `customerGroup` and `planId` that only the creating
 * request knows. A `sub_...` with no local row is either a Stripe object
 * created out of band (Dashboard, another product on the same account) or the
 * narrow race where `customer.subscription.created` overtakes our own commit
 * — and in that race the creating request has already written the correct
 * state. Manufacturing a row from the webhook would mean guessing the plan
 * that governs a family's entitlements. So: no row, no write, INFO log.
 *
 * **Terminal conditions do not retry.** `stripe_missing` and `unknown_status`
 * cannot be fixed by asking again; ten redeliveries against a permanent 404
 * spend ten Stripe calls to say what one metric increment already said. They
 * return normally (the SDK marks the event processed) and raise their signal
 * through `subscription_stripe_reconcile_total{outcome}`. Transient failures
 * — network, 5xx, rate limit — THROW, so the SDK's retry and dead-letter
 * machinery does its job.
 *
 * **When Stripe and we disagree about a status we cannot name, we write
 * NOTHING.** A partial update (periods yes, status no) leaves a row that is
 * internally inconsistent and looks fine; being visibly stale is recoverable,
 * being confidently wrong about whether a family is billing is not.
 */
@Injectable()
export class StripeSubscriptionReconcilerService {
  private readonly logger = new Logger(StripeSubscriptionReconcilerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
    /**
     * TS-042-followup-3b2-followup-1 — producer-side outbox. A pause or
     * resume this service did not initiate is only ever seen here, and
     * the event is appended inside the same transaction as the row
     * update so a rollback never leaves an orphan (PDD §7.3,
     * CLAUDE.md §5.3).
     */
    private readonly outbox: OutboxService,
  ) {}

  async reconcile(args: {
    readonly stripeSubscriptionId: string;
    readonly stripeEventId: string;
    readonly stripeEventType: string;
    readonly observedAt: Date;
  }): Promise<ReconcileOutcome> {
    const { stripeSubscriptionId, stripeEventId, stripeEventType, observedAt } = args;

    const existing = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: {
        id: true,
        // Carried for the pause / resume events the reconciler emits —
        // both payloads name the customer of record.
        customerId: true,
        status: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        trialEnd: true,
        cancelAtPeriodEnd: true,
        canceledAt: true,
        pauseCollectionStartedAt: true,
        pauseCollectionResumesAt: true,
        pauseReason: true,
      },
    });

    if (existing === null) {
      this.logger.log(
        `stripe.subscription.reconcile.not_tracked ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripeSubscriptionId,
        })}`,
      );
      return { kind: 'not_tracked' };
    }

    const fetched = await this.fetch(stripeSubscriptionId);
    if (fetched === null) {
      this.logger.error(
        `stripe.subscription.reconcile.stripe_missing ${JSON.stringify({
          stripeEventId,
          stripeEventType,
          stripeSubscriptionId,
          subscriptionId: existing.id,
        })} — local row references a subscription Stripe no longer serves`,
      );
      return { kind: 'stripe_missing' };
    }

    const mapped = mapStripeSubscription({
      subscription: fetched,
      existing: {
        pauseCollectionStartedAt: existing.pauseCollectionStartedAt,
        pauseReason: existing.pauseReason,
      },
      observedAt,
    });

    if (mapped.kind === 'unknown_status') {
      this.logger.error(
        `stripe.subscription.reconcile.unknown_status ${JSON.stringify({
          stripeEventId,
          stripeSubscriptionId,
          subscriptionId: existing.id,
          stripeStatus: mapped.stripeStatus,
        })} — refusing to write a partial update`,
      );
      return { kind: 'unknown_status', stripeStatus: mapped.stripeStatus };
    }

    const current: ReconcilableSubscriptionFields = {
      status: existing.status,
      currentPeriodStart: existing.currentPeriodStart,
      currentPeriodEnd: existing.currentPeriodEnd,
      trialEnd: existing.trialEnd,
      cancelAtPeriodEnd: existing.cancelAtPeriodEnd,
      canceledAt: existing.canceledAt,
      pauseCollectionStartedAt: existing.pauseCollectionStartedAt,
      pauseCollectionResumesAt: existing.pauseCollectionResumesAt,
      pauseReason: existing.pauseReason,
    };

    const changed = changedFields(mapped.fields, current);
    if (changed.length === 0) {
      return { kind: 'no_change' };
    }

    await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.subscription.update({
        where: { id: existing.id },
        data: { ...mapped.fields },
      });

      // History records TRANSITIONS, not webhook traffic. A period roll or a
      // cancel-at-period-end flag moving is a field change, not a state
      // change, and a row for every one of them would bury the status
      // transitions anyone actually reads this table for.
      if (mapped.fields.status !== current.status) {
        await tx.subscriptionHistory.create({
          data: {
            subscriptionId: existing.id,
            event: historyEventForStatus(mapped.fields.status),
            fromStatus: current.status,
            toStatus: mapped.fields.status,
            // System-driven transition: no acting user. `source` carries the
            // Stripe event id so the row is traceable back to the exact
            // delivery that caused it (the schema's stated convention).
            actorUserId: null,
            actorKind: 'system',
            source: stripeEventId,
            context: {
              stripeEventType,
              stripeSubscriptionId,
              changedFields: [...changed],
            },
          },
        });
      }

      await this.emitPauseTransition(tx, {
        subscriptionId: existing.id,
        customerId: existing.customerId,
        stripeEventId,
        observedAt,
        wasPaused: current.pauseCollectionStartedAt !== null,
        isPaused: mapped.fields.pauseCollectionStartedAt !== null,
        resumesAt: mapped.fields.pauseCollectionResumesAt,
        fromStatus: current.status,
        toStatus: mapped.fields.status,
      });
    });

    this.logger.log(
      `stripe.subscription.reconciled ${JSON.stringify({
        stripeEventId,
        stripeEventType,
        subscriptionId: existing.id,
        fromStatus: current.status,
        toStatus: mapped.fields.status,
        changed,
      })}`,
    );

    return { kind: 'reconciled', changed: [...changed] };
  }

  /**
   * Emit `subscription.paused` / `subscription.resumed` when the
   * reconciler observes collection pausing or resuming
   * (TS-042-followup-3b2-followup-1).
   *
   * **Why this exists.** Before it, the only producer of either event was
   * `DunningService.pause/resumeSubscription` — the explicit request made
   * through this platform. Two real paths bypassed that:
   *
   *   - A pause created with `resumesAt` is resumed **by Stripe** when
   *     that instant arrives. Stripe fires `customer.subscription.updated`,
   *     this reconciler clears the local pause columns, and nothing was
   *     told. Any consumer that suspended work on the pause never
   *     restarted it — service-accounting's deferred-revenue balance sat
   *     at `paused` permanently, the daily sweep skipping it, the
   *     remaining revenue never recognised, while this service and Stripe
   *     both looked correct.
   *   - Collection paused or resumed from the Stripe Dashboard, same
   *     shape in the other direction.
   *
   * **The pause columns are the trigger, not the status.** `status` is a
   * derived view — `mapStripeSubscription` reports `paused` whenever
   * `pause_collection` is set — and keying on it would fire on any status
   * churn around an unchanged pause. `pauseCollectionStartedAt` moving to
   * or from `null` is the actual transition.
   *
   * **Double emission is safe and is the right trade.** The explicit
   * resume path writes the row and emits in its own transaction; by the
   * time Stripe's webhook arrives the pause columns already agree, so
   * `changedFields` is empty and `reconcile` returns before this runs. In
   * the narrow race where the webhook lands first, both producers emit —
   * two events with different ids, and the consumer's status guard makes
   * the second a no-op. A missed resume strands revenue; a duplicate one
   * is absorbed. Only one of those is recoverable without a human.
   *
   * **Event id is keyed to the Stripe delivery**, not to a history row:
   * the history row is only written when `status` changes, and the
   * transition that matters here is the pause columns'. A Stripe
   * redelivery re-fetches, finds nothing changed, and never reaches this
   * code.
   *
   * A validation failure THROWS, rolling back the row update with it. The
   * alternative — commit the state change and drop the event — is the
   * exact silent divergence this method exists to close.
   */
  private async emitPauseTransition(
    tx: PrismaTransactionClient,
    args: {
      readonly subscriptionId: string;
      readonly customerId: string;
      readonly stripeEventId: string;
      readonly observedAt: Date;
      readonly wasPaused: boolean;
      readonly isPaused: boolean;
      readonly resumesAt: Date | null;
      readonly fromStatus: ReconcilableSubscriptionFields['status'];
      readonly toStatus: ReconcilableSubscriptionFields['status'];
    },
  ): Promise<void> {
    if (args.wasPaused === args.isPaused) {
      return;
    }

    const executor = tx as unknown as OutboxRawExecutor;
    const occurredAt = args.observedAt;

    if (args.isPaused) {
      const eventId = `${args.subscriptionId}.paused.stripe.${args.stripeEventId}`;
      const appended = await this.outbox.append(executor, {
        eventName: SUBSCRIPTION_PAUSED,
        eventId,
        occurredAt,
        payload: {
          eventId,
          occurredAt: occurredAt.toISOString(),
          subscriptionId: args.subscriptionId,
          customerId: args.customerId,
          // Stripe reports THAT collection is paused, never when. The
          // observation instant is the honest answer and is the same
          // value the row's `pauseCollectionStartedAt` just took.
          pausedAt: occurredAt.toISOString(),
          resumesAt: args.resumesAt?.toISOString() ?? null,
          // An out-of-band pause carries no reason on this platform —
          // `pauseReason` is only written by our own pause endpoint.
          hasReason: false,
          // Nobody here requested it. See `SubscriptionPausedSchema`:
          // null is the discriminator, not a missing value.
          requesterUserId: null,
          fromStatus: args.fromStatus,
        },
      });
      if (appended.kind !== 'appended') {
        throw new Error(
          `stripe-subscription-reconciler: ${SUBSCRIPTION_PAUSED} payload rejected by the outbox SDK (${JSON.stringify(appended.issues)})`,
        );
      }
      this.logger.log(
        `stripe.subscription.reconcile.paused_out_of_band ${JSON.stringify({
          stripeEventId: args.stripeEventId,
          subscriptionId: args.subscriptionId,
          fromStatus: args.fromStatus,
        })}`,
      );
      return;
    }

    const eventId = `${args.subscriptionId}.resumed.stripe.${args.stripeEventId}`;
    const appended = await this.outbox.append(executor, {
      eventName: SUBSCRIPTION_RESUMED,
      eventId,
      occurredAt,
      payload: {
        eventId,
        occurredAt: occurredAt.toISOString(),
        subscriptionId: args.subscriptionId,
        customerId: args.customerId,
        // Observation instant, at or after the true resume. A consumer
        // compensating for suspended time therefore over-compensates
        // slightly, which errs in the customer's favour.
        resumedAt: occurredAt.toISOString(),
        requesterUserId: null,
        // Whatever Stripe reports — `past_due` for a subscription that
        // was paused mid-dunning. Never assumed `active`.
        toStatus: args.toStatus,
        hasNote: false,
      },
    });
    if (appended.kind !== 'appended') {
      throw new Error(
        `stripe-subscription-reconciler: ${SUBSCRIPTION_RESUMED} payload rejected by the outbox SDK (${JSON.stringify(appended.issues)})`,
      );
    }
    this.logger.log(
      `stripe.subscription.reconcile.resumed_out_of_band ${JSON.stringify({
        stripeEventId: args.stripeEventId,
        subscriptionId: args.subscriptionId,
        toStatus: args.toStatus,
      })}`,
    );
  }

  /**
   * Fetch the subscription, distinguishing "Stripe says it is gone" from
   * "we could not ask".
   *
   * `resource_missing` is terminal and returns null; everything else — a
   * network blip, a 429, a Stripe 5xx — re-throws so the consumer SDK retries
   * on its own schedule. Getting this split wrong in either direction is
   * expensive: swallowing a transient error silently abandons a real billing
   * change, and retrying a permanent 404 burns the dead-letter queue's signal
   * on a row that needs a human, not another attempt.
   */
  private async fetch(stripeSubscriptionId: string): Promise<Stripe.Subscription | null> {
    try {
      return await this.stripe.subscriptions.retrieve(stripeSubscriptionId);
    } catch (err) {
      if (
        err instanceof Stripe.errors.StripeInvalidRequestError &&
        err.code === 'resource_missing'
      ) {
        return null;
      }
      throw err;
    }
  }
}

export { StripeSubscriptionShapeError };
