import { Injectable, Logger } from '@nestjs/common';
import { SUBSCRIPTION_ACTIVATED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import {
  SubscriptionRevenueRecognizerService,
  type RecognizeActivationFailure,
} from '../../revenue-recognition/services/subscription-revenue-recognizer.service';

/**
 * Handler for `subscription.activated` events landed via the outbox
 * relay (TS-142-followup-2-followup-2; PDD §7.3, §11.2; CLAUDE.md §5.3,
 * §6, §17.17).
 *
 * Translates the event payload into a `RecognizeActivationRequest`
 * and delegates to `SubscriptionRevenueRecognizerService.recognizeActivation`,
 * which posts the activation journal (DR Cash / CR Deferred Revenue
 * per-plan) AND creates the `deferred_revenue_balances` row in a single
 * transaction. PDD Appendix A — "Tier 2 subscription charged ($299):
 * Cash $299 / Deferred Revenue $299".
 *
 * **Idempotency.** The handler is idempotent on `envelope.eventId`:
 *   1. SDK dedup table — `accounting.outbox_consumer_dedup` PK on
 *      `(consumer_group, event_id)`; a re-delivered event whose row is
 *      already `processed` short-circuits at the SDK before this code
 *      runs. CLAUDE.md §5.3.
 *   2. Service-layer — `deferred_revenue_balances.source_event_id`
 *      UNIQUE + `journals.source_event_id` UNIQUE. Even if the SDK's
 *      dedup table is wiped, the recognizer's own invariant catches
 *      the re-delivery and returns `result: 'idempotent_replay'`. The
 *      consumer maps the relay-side `envelope.eventId` 1:1 into the
 *      recognizer's `sourceEventId` so both layers share the same key.
 *
 * **`amountMinor` from the event payload.** TS-142-followup-2-followup-2
 * evolved the `subscription.activated` schema to carry `amountMinor`
 * + `currency` so the consumer has everything it needs without a
 * cross-service lookup (cross-service DB joins are forbidden per
 * CLAUDE.md §2.3). The amount is the activation total for the service
 * period — one month's price for monthly billing, the annual price
 * for annual billing. The recognizer amortises this amount over
 * `[periodStart, periodEnd]` per CLAUDE.md §17.17.
 *
 * **Failure handling.** Throws on any recognizer failure so the SDK
 * records the attempt + leaves the entry in the PEL for redelivery.
 * The retry / dead-letter cadence is governed by
 * `OUTBOX_CONSUMER_MAX_ATTEMPTS` and `OUTBOX_CONSUMER_RECLAIM_IDLE_MS`
 * (env-tuned). Once attempts exhaust the cap, the row dead-letters
 * for ops triage (visible via TS-142-followup-5 when that admin
 * surface lands).
 */
@Injectable()
export class SubscriptionActivatedHandler {
  private readonly logger = new Logger(SubscriptionActivatedHandler.name);

  constructor(private readonly recognizer: SubscriptionRevenueRecognizerService) {}

  /**
   * Invoked by `OutboxConsumerService` after the SDK has parsed the
   * stream entry against `SubscriptionActivatedSchema`. The
   * `args.payload` shape is guaranteed at the type AND runtime layer.
   */
  async handle(args: HandleArgs<typeof SUBSCRIPTION_ACTIVATED>): Promise<void> {
    const { envelope, payload } = args;

    if (payload.currency !== 'USD') {
      // Phase 1 only supports USD. A non-USD activation arriving on
      // the bus is a contract drift the consumer surfaces loudly so
      // ops can rotate the producer back to the supported currency
      // set. Phase 3 multi-currency lands with TS-420 — this branch
      // gates the consumer-side enablement.
      this.logger.error(
        {
          eventId: envelope.eventId,
          subscriptionId: payload.subscriptionId,
          currency: payload.currency,
        },
        'outbox.subscription-activated.unsupported-currency',
      );
      throw new Error(
        `subscription.activated: unsupported currency '${payload.currency}' — Phase 1 only supports USD (CLAUDE.md §11.4)`,
      );
    }

    const result = await this.recognizer.recognizeActivation({
      subscriptionId: payload.subscriptionId,
      customerId: payload.customerId,
      customerGroup: payload.customerGroup,
      planCode: payload.planCode,
      amountMinor: payload.amountMinor,
      currency: 'USD',
      servicePeriodStart: payload.periodStart,
      servicePeriodEnd: payload.periodEnd,
      sourceEventId: envelope.eventId,
      occurredAt: envelope.occurredAt.toISOString(),
      description: `Subscription activation via outbox: ${payload.subscriptionId} (${payload.planCode})`,
      context: {
        producerService: envelope.producerService,
        producerSchema: envelope.producerSchema,
        planId: payload.planId,
      },
    });

    if (!result.ok) {
      const error = formatActivationFailure(result.failure);
      this.logger.error(
        {
          eventId: envelope.eventId,
          subscriptionId: payload.subscriptionId,
          planCode: payload.planCode,
          amountMinor: payload.amountMinor,
          failure: result.failure.kind,
          error,
        },
        'outbox.subscription-activated.recognize-failed',
      );
      throw new Error(error);
    }

    this.logger.log(
      {
        eventId: envelope.eventId,
        subscriptionId: payload.subscriptionId,
        planCode: payload.planCode,
        amountMinor: payload.amountMinor,
        balanceId: result.value.balanceId,
        activationJournalId: result.value.activationJournalId,
        recognizerResult: result.value.result,
      },
      'outbox.subscription-activated.recognized',
    );
  }
}

/**
 * Format a recognizer failure into a single-line error string the SDK
 * persists on the dedup row's `last_error` column (truncated to 2000
 * chars in `PgConsumerDedupStore.recordFailure`). Keeps the failure
 * shape opaque enough for the dedup admin UI to render uniformly while
 * carrying the discriminator for ops triage.
 */
function formatActivationFailure(failure: RecognizeActivationFailure): string {
  switch (failure.kind) {
    case 'period_inverted':
      return 'period_inverted: servicePeriodStart must be strictly before servicePeriodEnd';
    case 'amount_non_positive':
      return 'amount_non_positive: amountMinor must be > 0';
    case 'subscription_period_conflict':
      return `subscription_period_conflict: another balance exists for subscriptionId=${failure.subscriptionId} servicePeriodStart=${failure.servicePeriodStart}`;
    case 'journal_post_failed':
      return `journal_post_failed: ${failure.failure.kind}`;
  }
}
