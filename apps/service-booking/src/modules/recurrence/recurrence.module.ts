import { Module } from '@nestjs/common';

import { SubjectHoldsModule } from '../subject-holds/subject-holds.module';
import { RecurrenceController } from './controllers/recurrence.controller';
import { RecurrenceService } from './recurrence.service';

/**
 * Recurrence bounded module (TS-061; PRD §6.3).
 *
 * Composition:
 *   - `RecurrenceController` — the single `POST /api/v1/bookings/recurring`
 *     HTTP endpoint.
 *   - `RecurrenceService` — RRULE expansion + atomic-explode write
 *     orchestration. Inserts every materialised child booking + the
 *     `booking_recurrence` row + one `booking.created` outbox event
 *     per child inside one Prisma `$transaction`.
 *
 * Depends on:
 *   - `OutboxModule` — registered globally in `AppModule.forRoot`; the
 *     injected `OutboxService` lands the per-child events
 *     transactionally with the booking row writes (PDD §7.3,
 *     CLAUDE.md §5.3).
 *   - `IdempotencyModule` — registered globally; the `@Idempotent()`
 *     interceptor caches the response so a retried POST returns the
 *     same series rather than re-exploding (CLAUDE.md §3.3 / §17.5).
 *   - `PrismaModule` — registered globally; `PrismaService` is in
 *     scope for the `$transaction` callback.
 *
 * No exports today — cross-service reads of recurring-series state
 * land via the gateway BFF (TS-140) or via the booking.* events on
 * the bus (TS-142).
 */
@Module({
  // TS-304 — `SubjectHoldsModule` exports the trust & safety hold screen the
  // series create consults once, before the RRULE is expanded.
  imports: [SubjectHoldsModule],
  controllers: [RecurrenceController],
  providers: [RecurrenceService],
})
export class RecurrenceModule {}
