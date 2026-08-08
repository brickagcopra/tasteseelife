import { Injectable, Logger } from '@nestjs/common';
import { TRUST_SAFETY_BOOKING_HOLD_REQUESTED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { SubjectHoldsService } from '../../subject-holds/services/subject-holds.service';

/**
 * Handler for `trust_safety.booking_hold.requested` (TS-304; PRD §10.14;
 * PDD §16.1; CLAUDE.md §5.3, §12).
 *
 * Suspends the named subjects' live bookings. **The handler makes no
 * judgement about whether the hold is warranted** — the severity predicate
 * ran on the trust & safety side before the event was published
 * (`booking-hold-policy.ts`), and re-deriving it here would put a second
 * copy of "which concerns stop a family's care" in the service with the
 * least context to own it. The payload's `severity` is carried through to
 * the hold row for the ops read, not consulted as a gate.
 *
 * **Idempotency (CLAUDE.md §5.3).** Three layers, in the order they fire:
 *   1. The SDK's `booking.outbox_consumer_dedup` PK on
 *      `(consumer_group, event_id)` — a redelivery whose row is already
 *      `processed` never reaches this code.
 *   2. `booking_subject_holds.(source_event_id, subject_kind)` UNIQUE plus
 *      `(incident_id, subject_kind, subject_id)` UNIQUE — the domain guard,
 *      applied via `createMany({ skipDuplicates: true })`. Survives a
 *      truncated dedup table.
 *   3. The booking stamp only touches rows where `held_by_incident_id IS
 *      NULL`, so a replay cannot overwrite an earlier incident's recorded
 *      reason.
 *
 * **Failure handling.** Throws so the SDK records the attempt and leaves the
 * entry in the PEL for redelivery. A hold that failed to apply must be
 * retried, loudly and visibly: the alternative is a senior continuing to
 * receive visits from a provider under a critical concern, with nothing in
 * the system saying so. The subjectless case is the one exception — it is a
 * permanent producer bug, not a transient failure, so it is logged at error
 * and NOT retried (the contract's `superRefine` should have made it
 * impossible; if it arrives anyway, redelivering it forever only buries the
 * signal).
 */
@Injectable()
export class BookingHoldRequestedHandler {
  private readonly logger = new Logger(BookingHoldRequestedHandler.name);

  constructor(private readonly holds: SubjectHoldsService) {}

  async handle(args: HandleArgs<typeof TRUST_SAFETY_BOOKING_HOLD_REQUESTED>): Promise<void> {
    const { envelope, payload } = args;

    if (payload.providerId === null && payload.seniorId === null && payload.householdId === null) {
      // Permanent — swallowed on purpose so the SDK marks it processed
      // instead of redelivering a malformed stop order ten times. The error
      // log IS the escalation.
      this.logger.error(
        `booking.hold_requested.no_subject ${JSON.stringify({
          eventId: envelope.eventId,
          incidentId: payload.incidentId,
        })} — producer published a subjectless hold; ignoring rather than freezing the platform`,
      );
      return;
    }

    const result = await this.holds.applySubjectHold({
      incidentId: payload.incidentId,
      severity: payload.severity,
      category: payload.category,
      providerId: payload.providerId,
      seniorId: payload.seniorId,
      householdId: payload.householdId,
      // The incident's clock, from the event — a redelivered or backfilled
      // hold must not look like it started when we happened to process it.
      heldAt: new Date(payload.requestedAt),
      sourceEventId: envelope.eventId,
    });

    // WARN, not LOG: a hold means a family's scheduled care has stopped.
    // That is a state an operator should be able to find in the logs without
    // knowing to look for it.
    this.logger.warn(
      `booking.hold_requested.applied ${JSON.stringify({
        eventId: envelope.eventId,
        incidentId: payload.incidentId,
        severity: payload.severity,
        holdsCreated: result.holdsCreated,
        bookingsHeld: result.bookingsHeld,
        producerService: envelope.producerService,
      })}`,
    );
  }
}
