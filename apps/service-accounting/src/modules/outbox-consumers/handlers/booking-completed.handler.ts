import { Injectable, Logger } from '@nestjs/common';
import { BOOKING_COMPLETED, type BookingCommissionRequest } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import {
  BookingCommissionRecognizerService,
  type RecognizeBookingCompletionFailure,
} from '../../booking-commission/services/booking-commission-recognizer.service';

/**
 * Handler for `booking.completed` events landed via the outbox relay
 * (TS-083-followup-3 / TS-142-followup-3; PDD §9.2, Appendix A;
 * CLAUDE.md §5.3, §6).
 *
 * This is the event-driven counterpart of the synchronous HTTP scaffold
 * `POST /api/v1/internal/booking/completed` (TS-083). Both paths delegate
 * to the SAME `BookingCommissionRecognizerService.recognizeBookingCompleted`,
 * which posts the four-line booking-completion journal AND upserts the
 * provider's running payable balance in one orchestrated flow:
 *
 *     DR Cash                              $gross
 *     CR Marketplace Revenue (gross)       $gross
 *     DR Marketplace Revenue Contra        $providerPortion
 *     CR Provider Payable                  $providerPortion
 *
 * PDD Appendix A — "Booking completed ($150, 20% commission): Cash $150 /
 * Marketplace Revenue (gross) $150" + "Same booking, provider portion:
 * Marketplace Revenue (contra) $120 / Provider Payable $120".
 *
 * Once this consumer-side path has soaked in staging long enough to prove
 * zero-loss + idempotent, the synchronous HTTP dispatcher in
 * `service-booking` retires (TS-142-followup-3) — the internal endpoint
 * stays for ops re-dispatch but the day-to-day path becomes event-driven.
 *
 * **Idempotency.** The handler is idempotent on `envelope.eventId`:
 *   1. SDK dedup table — `accounting.outbox_consumer_dedup` PK on
 *      `(consumer_group, event_id)`; a re-delivered event whose row is
 *      already `processed` short-circuits at the SDK before this code
 *      runs. CLAUDE.md §5.3.
 *   2. Service-layer — `journals.source_event_id` UNIQUE. Even if the
 *      SDK's dedup table is wiped, the recognizer's own pre-flight
 *      (`journal.findUnique({ where: { sourceEventId } })`) detects the
 *      replay and returns `result: 'idempotent_replay'` WITHOUT
 *      re-incrementing the running payable balance. The consumer maps
 *      the relay-side `envelope.eventId` 1:1 into the recognizer's
 *      `sourceEventId` so both layers share the same key.
 *
 * **Money fields from the event payload.** `booking.completed` carries
 * the resolved `grossAmountMinor` / `providerAmountMinor` /
 * `marketplaceAmountMinor` as integer USD minor units (CLAUDE.md §17.6
 * — no float math for money). The contract enforces the
 * `gross == provider + marketplace` invariant at parse time (the SDK
 * validates against `BookingCompletedSchema` before this code runs);
 * the recognizer guards the same invariant as a second line of defence.
 * No cross-service lookup is needed — cross-service DB joins are
 * forbidden (CLAUDE.md §2.3).
 *
 * **Failure handling.** Throws on any recognizer failure so the SDK
 * records the attempt + leaves the entry in the PEL for redelivery.
 * The retry / dead-letter cadence is governed by
 * `OUTBOX_CONSUMER_MAX_ATTEMPTS` and `OUTBOX_CONSUMER_RECLAIM_IDLE_MS`
 * (env-tuned). `amount_non_positive` / `amount_invariant_violated` are
 * PERMANENT failures (a producer bug); they dead-letter after the cap
 * for ops triage (TS-142-followup-5) rather than auto-correcting
 * silently (CLAUDE.md §6 — "do not auto-correct silently").
 */
@Injectable()
export class BookingCompletedHandler {
  private readonly logger = new Logger(BookingCompletedHandler.name);

  constructor(private readonly recognizer: BookingCommissionRecognizerService) {}

  /**
   * Invoked by `OutboxConsumerService` after the SDK has parsed the
   * stream entry against `BookingCompletedSchema`. The `args.payload`
   * shape is guaranteed at the type AND runtime layer.
   */
  async handle(args: HandleArgs<typeof BOOKING_COMPLETED>): Promise<void> {
    const { envelope, payload } = args;

    if (payload.currency !== 'USD') {
      // Phase 1 only supports USD. A non-USD completion arriving on the
      // bus is a contract drift the consumer surfaces loudly so ops can
      // rotate the producer back to the supported currency set. Phase 3
      // multi-currency lands with TS-264 / TS-420 — this branch gates the
      // consumer-side enablement (CLAUDE.md §11.4).
      this.logger.error(
        {
          eventId: envelope.eventId,
          bookingId: payload.bookingId,
          currency: payload.currency,
        },
        'outbox.booking-completed.unsupported-currency',
      );
      throw new Error(
        `booking.completed: unsupported currency '${payload.currency}' — Phase 1 only supports USD (CLAUDE.md §11.4)`,
      );
    }

    const request: BookingCommissionRequest = {
      bookingId: payload.bookingId,
      providerId: payload.providerId,
      householdId: payload.householdId,
      grossAmountMinor: payload.grossAmountMinor,
      providerAmountMinor: payload.providerAmountMinor,
      marketplaceAmountMinor: payload.marketplaceAmountMinor,
      commissionRateBps: payload.commissionRateBps,
      currency: 'USD',
      completedAt: payload.completedAt,
      sourceEventId: envelope.eventId,
      description: `Booking completion via outbox: ${payload.bookingId} (provider ${payload.providerId})`,
      context: {
        producerService: envelope.producerService,
        producerSchema: envelope.producerSchema,
        seniorId: payload.seniorId,
        serviceKind: payload.serviceKind,
      },
    };

    const result = await this.recognizer.recognizeBookingCompleted(request);

    if (!result.ok) {
      const error = formatBookingFailure(result.failure);
      this.logger.error(
        {
          eventId: envelope.eventId,
          bookingId: payload.bookingId,
          providerId: payload.providerId,
          grossAmountMinor: payload.grossAmountMinor,
          providerAmountMinor: payload.providerAmountMinor,
          marketplaceAmountMinor: payload.marketplaceAmountMinor,
          failure: result.failure.kind,
          error,
        },
        'outbox.booking-completed.recognize-failed',
      );
      throw new Error(error);
    }

    this.logger.log(
      {
        eventId: envelope.eventId,
        bookingId: payload.bookingId,
        providerId: payload.providerId,
        journalId: result.value.journalId,
        grossAmountMinor: result.value.grossAmountMinor,
        providerAmountMinor: result.value.providerAmountMinor,
        marketplaceAmountMinor: result.value.marketplaceAmountMinor,
        commissionRateBps: result.value.commissionRateBps,
        runningPayableMinor: result.value.runningPayableMinor,
        recognizerResult: result.value.result,
      },
      'outbox.booking-completed.recognized',
    );
  }
}

/**
 * Format a recognizer failure into a single-line error string the SDK
 * persists on the dedup row's `last_error` column (truncated to 2000
 * chars in `PgConsumerDedupStore.recordFailure`). Keeps the failure
 * shape opaque enough for the dedup admin UI to render uniformly while
 * carrying the discriminator for ops triage. Mirrors
 * `formatActivationFailure` in `subscription-activated.handler.ts`.
 */
function formatBookingFailure(failure: RecognizeBookingCompletionFailure): string {
  switch (failure.kind) {
    case 'amount_non_positive':
      return 'amount_non_positive: grossAmountMinor must be > 0 (upstream must filter zero-value completions before publishing)';
    case 'amount_invariant_violated':
      return 'amount_invariant_violated: grossAmountMinor must equal providerAmountMinor + marketplaceAmountMinor';
    case 'journal_post_failed':
      return `journal_post_failed: ${failure.failure.kind}`;
  }
}
