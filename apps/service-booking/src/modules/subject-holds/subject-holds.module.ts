import { Module } from '@nestjs/common';

import { AdminBookingHoldsController } from './controllers/admin-booking-holds.controller';
import { SubjectHoldsReadService } from './services/subject-holds-read.service';
import { SubjectHoldsService } from './services/subject-holds.service';

/**
 * Trust & safety subject holds (TS-304; PRD §10.14; PDD §16.1;
 * CLAUDE.md §12).
 *
 * Exports `SubjectHoldsService` for three consumers:
 *
 *   - `BookingsModule` — `createBooking` screens the subjects before any
 *     side effect (the pre-flight, alongside the TS-064 tier gate).
 *   - `RecurrenceModule` — the recurring-series create screens once for the
 *     whole series; a held subject must not get 52 materialised visits.
 *   - `OutboxConsumersModule` — the two handlers that apply and release the
 *     hold from the `trust_safety.booking_hold.*` pair.
 *
 * `PrismaModule` is registered globally in `AppModule`, so the service gets
 * it via DI without an explicit import (same as `TierGatingModule`).
 *
 * ONE controller, and it READS ONLY (`AdminBookingHoldsController`,
 * TS-304-followup-3). There is still deliberately NO HTTP surface for
 * placing or lifting a hold from this side: a hold originates from a
 * trust & safety incident and is lifted by the review committee closing
 * it, so a write endpoint here would be a way to un-suspend a provider
 * without touching the incident that suspended them. The read half was
 * the gap — `booking_subject_holds` was queryable only in-process, so a
 * committee deliberating on a hold had no way to weigh what it cost.
 *
 * `SubjectHoldsReadService` is separate from `SubjectHoldsService` so the
 * ops question cannot be answered by a method that also mutates, and so
 * the write/screen class keeps every member on the booking-create
 * critical path. It is NOT exported: nothing in-process asks this
 * question.
 */
@Module({
  controllers: [AdminBookingHoldsController],
  providers: [SubjectHoldsService, SubjectHoldsReadService],
  exports: [SubjectHoldsService],
})
export class SubjectHoldsModule {}
