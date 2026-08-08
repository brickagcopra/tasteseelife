import { Module } from '@nestjs/common';

import { VisitNotesController } from './controllers/visit-notes.controller';
import { VisitNotesService } from './services/visit-notes.service';

/**
 * Booking visit notes bounded module (TS-062).
 *
 * Composition:
 *   - `VisitNotesController` — two HTTP endpoints (PUT upsert + GET
 *     read) under `/api/v1/bookings/:bookingId/visit-notes`.
 *   - `VisitNotesService` — single-row upsert and read against
 *     `booking_visit_notes`, gated on the booking lifecycle status
 *     (provider can only record notes during `in_progress` or
 *     `completed`).
 *
 * Depends on:
 *   - `IdempotencyModule` — registered globally in `AppModule.forRoot`
 *     so the `@Idempotent()` interceptor fires on the write endpoint.
 *   - `PrismaModule` — registered globally so `PrismaService` is in
 *     scope.
 *
 * No exports today — nothing outside this module consumes visit-note
 * state directly. Cross-service reads (the family wellness summary,
 * PRD §6.9) land via the gateway BFF (TS-140) or via a future
 * `booking.visit_notes_recorded` event on the bus (TS-142;
 * captured as a TS-062-followup).
 */
@Module({
  controllers: [VisitNotesController],
  providers: [VisitNotesService],
})
export class VisitNotesModule {}
