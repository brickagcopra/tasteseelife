import { Injectable, Logger } from '@nestjs/common';
import { TRUST_SAFETY_BOOKING_HOLD_RELEASED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { SubjectHoldsService } from '../../subject-holds/services/subject-holds.service';

/**
 * Handler for `trust_safety.booking_hold.released` (TS-304; PRD §10.14;
 * PDD §16.1; CLAUDE.md §5.3, §12).
 *
 * Lifts the hold the review committee's closure ends, and re-evaluates each
 * suspended booking against any OTHER still-open hold before clearing it
 * (see `SubjectHoldsService.releaseSubjectHold` — a provider under two
 * concurrent concerns must not resume when only the first is dismissed).
 *
 * **A release for a hold that was never applied is a NO-OP, not an error.**
 * That case is reachable and expected: service-booking may have been down
 * when the request was published, the request may have dead-lettered, or an
 * operator may have cleared the row. `releaseSubjectHold` filters on
 * `releasedAt IS NULL` and reports zero counts, which is the correct
 * convergent behaviour. Treating it as a failure would put a release into
 * the redelivery loop forever, and the suspension it was meant to lift is
 * exactly what would stay stuck.
 *
 * **Unlike the requested half, a subjectless payload is not special-cased
 * here.** The contract refuses it, and `releaseSubjectHold` keys on
 * `incidentId` — it does not need the subjects to find the holds to lift
 * (they are used only to bound the re-evaluation query). A release is
 * fail-safe in the direction that matters: the worst outcome of an odd
 * payload is that a suspension persists and an operator has to look, which
 * beats resuming care that should be stopped.
 *
 * **Idempotency.** The SDK dedup table, then the `releasedAt IS NULL`
 * filter. A replay releases nothing and clears nothing.
 *
 * **Failure handling.** Throws on a genuine failure so the SDK retries. A
 * stuck release means a household's visits stay suspended after their
 * concern was resolved — a real harm, and one the dead-letter queue must
 * surface rather than swallow.
 */
@Injectable()
export class BookingHoldReleasedHandler {
  private readonly logger = new Logger(BookingHoldReleasedHandler.name);

  constructor(private readonly holds: SubjectHoldsService) {}

  async handle(args: HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_RELEASED>): Promise<void> {
    const { envelope, payload } = args;

    const result = await this.holds.releaseSubjectHold({
      incidentId: payload.incidentId,
      providerId: payload.providerId,
      seniorId: payload.seniorId,
      householdId: payload.householdId,
      // The committee's decision moment, from the event.
      releasedAt: new Date(payload.releasedAt),
      releaseEventId: envelope.eventId,
    });

    this.logger.log(
      `booking.hold_released.applied ${JSON.stringify({
        eventId: envelope.eventId,
        incidentId: payload.incidentId,
        severity: payload.severity,
        holdsReleased: result.holdsReleased,
        bookingsCleared: result.bookingsCleared,
        bookingsRestamped: result.bookingsRestamped,
        producerService: envelope.producerService,
      })}`,
    );

    if (result.bookingsRestamped > 0) {
      // Worth its own line: these visits did NOT resume. Someone reading the
      // release log should not conclude the family is unblocked.
      this.logger.warn(
        `booking.hold_released.still_held ${JSON.stringify({
          incidentId: payload.incidentId,
          bookingsRestamped: result.bookingsRestamped,
        })} — another open incident still holds these bookings`,
      );
    }
  }
}
