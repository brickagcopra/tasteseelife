import { Injectable, Logger } from '@nestjs/common';
import type {
  BookingCanceled,
  BookingCompleted,
  BookingConfirmed,
  BookingCreated,
  BookingDeclined,
} from '@taste-and-see/contracts';
import type { ConsumerEventEnvelope } from '@taste-and-see/nest-outbox-consumer';

import {
  projectBookingCanceled,
  projectBookingCompleted,
  projectBookingConfirmed,
  projectBookingCreated,
  projectBookingDeclined,
  type BookingFactContribution,
} from '../../metrics/booking-fact-projection';
import { ProviderMetricsProjectorService } from '../../metrics/services/provider-metrics-projector.service';

/**
 * Projects service-booking's lifecycle events into
 * `provider_booking_facts` (TS-305d).
 *
 * One handler class covering five events rather than five classes. They
 * are not five behaviours: each maps its payload to a contribution via a
 * pure function and hands it to the same projector, and splitting that
 * into five files would mean five copies of the same four lines with the
 * event name changed. The trust-safety consumer splits its handlers
 * because each one *grades* its event differently and opens a different
 * incident; there is no equivalent judgement here.
 *
 * **This handler is idempotent because its write is, not because it
 * checks.** It never reads before writing and never asks what else has
 * happened — the projector's `COALESCE` upsert makes a replay a no-op
 * and makes out-of-order arrival converge. So there is deliberately no
 * `source_event_id` guard of the kind `incidents` carries: several
 * distinct events legitimately write to one fact row, so a per-row
 * event-id UNIQUE would reject the second one.
 *
 * **A failure here must not be silent.** The method throws on a
 * projection failure so the SDK retries and, after
 * `OUTBOX_CONSUMER_MAX_ATTEMPTS`, dead-letters — a metrics row that
 * quietly stops updating would show a review committee a completion rate
 * frozen at some earlier month with nothing on the page to say so.
 */
@Injectable()
export class BookingLifecycleHandler {
  private readonly logger = new Logger(BookingLifecycleHandler.name);

  constructor(private readonly projector: ProviderMetricsProjectorService) {}

  async handleCreated(args: {
    envelope: ConsumerEventEnvelope;
    payload: BookingCreated;
  }): Promise<void> {
    await this.applyContribution(args.envelope, projectBookingCreated(args.payload));
  }

  async handleConfirmed(args: {
    envelope: ConsumerEventEnvelope;
    payload: BookingConfirmed;
  }): Promise<void> {
    await this.applyContribution(args.envelope, projectBookingConfirmed(args.payload));
  }

  async handleDeclined(args: {
    envelope: ConsumerEventEnvelope;
    payload: BookingDeclined;
  }): Promise<void> {
    await this.applyContribution(args.envelope, projectBookingDeclined(args.payload));
  }

  async handleCompleted(args: {
    envelope: ConsumerEventEnvelope;
    payload: BookingCompleted;
  }): Promise<void> {
    await this.applyContribution(args.envelope, projectBookingCompleted(args.payload));
  }

  async handleCanceled(args: {
    envelope: ConsumerEventEnvelope;
    payload: BookingCanceled;
  }): Promise<void> {
    await this.applyContribution(args.envelope, projectBookingCanceled(args.payload));
  }

  /**
   * The single write path.
   *
   * The log line carries the event name, the booking and the provider —
   * ids only. No household id, no senior id, no money, no free text: a
   * log stream replicates far wider than the table it describes, and
   * nothing about a reliability projection needs to know whose visit it
   * was (CLAUDE.md §3.9, §10).
   */
  private async applyContribution(
    envelope: ConsumerEventEnvelope,
    contribution: BookingFactContribution,
  ): Promise<void> {
    await this.projector.apply(contribution);

    this.logger.log(
      {
        eventId: envelope.eventId,
        eventName: envelope.eventName,
        bookingId: contribution.bookingId,
        providerId: contribution.providerId,
      },
      'provider-metrics: booking fact projected',
    );
  }
}
