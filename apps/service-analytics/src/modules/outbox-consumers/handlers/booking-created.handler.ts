import { Injectable, Logger } from '@nestjs/common';
import { BOOKING_CREATED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { RawEventsService } from '../../raw-events/raw-events.service';

/**
 * Handler for `booking.created` events landed via the outbox relay
 * (TS-217-prep-3a; PDD §23.1; CLAUDE.md §5.3).
 *
 * Persists the raw event into `analytics.booking_created_events` so the
 * TS-217-prep-3b nightly aggregation can compute the query→booking conversion
 * mart. Thin handler — delegates persistence + idempotency to
 * `RawEventsService` and logs the outcome.
 *
 * **Conversion caveat.** `booking.created` carries `householdId` but NOT
 * `actorUserId` (see `BookingCreatedSchema`), so an exact `actorUserId` join
 * against `search_events` is impossible in the interim. prep-3b computes an
 * approximate `(household_id, time-window)` conversion; the precise per-search
 * attribution lands with TS-217-prep-4 (search-correlation id threaded into
 * `booking.created`).
 *
 * **Idempotency.** Idempotent on `envelope.eventId`:
 *   1. SDK dedup table — `analytics.outbox_consumer_dedup` PK.
 *   2. Persistence layer — `analytics.booking_created_events.event_id` PK;
 *      `createMany({ skipDuplicates: true })` no-ops a redelivery.
 *
 * **Failure handling.** Throws on any persistence failure so the SDK leaves the
 * entry in the PEL for redelivery.
 */
@Injectable()
export class BookingCreatedHandler {
  private readonly logger = new Logger(BookingCreatedHandler.name);

  constructor(private readonly rawEvents: RawEventsService) {}

  async handle(args: HandleArgs<typeof BOOKING_CREATED>): Promise<void> {
    const { envelope, payload } = args;

    const { persisted } = await this.rawEvents.persistBookingCreated(envelope, payload);

    this.logger.log(
      {
        eventId: envelope.eventId,
        bookingId: payload.bookingId,
        householdId: payload.householdId,
        providerId: payload.providerId,
        serviceKind: payload.serviceKind,
        persisted,
      },
      persisted ? 'outbox.booking-created.persisted' : 'outbox.booking-created.replayed',
    );
  }
}
