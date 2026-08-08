import { Module } from '@nestjs/common';

import { DisputesController } from './controllers/disputes.controller';
import { DisputesService } from './services/disputes.service';

/**
 * Booking disputes bounded module (TS-065; PRD §10.5).
 *
 * Composition:
 *   - `DisputesController` — four HTTP endpoints covering the dispute
 *     lifecycle: POST open (under `/api/v1/bookings/:bookingId/disputes`),
 *     GET list (same root), GET single (`/api/v1/disputes/:disputeId`),
 *     PATCH update (same root + id).
 *   - `DisputesService` — `booking_disputes` row mutations + outbox
 *     `booking.dispute_opened` / `booking.dispute_resolved` events
 *     atomically inside a Prisma `$transaction`.
 *
 * Depends on:
 *   - `OutboxModule` — registered globally in `AppModule.forRoot` so
 *     the injected `OutboxService` is in scope.
 *   - `IdempotencyModule` — registered globally in `AppModule.forRoot`
 *     so the `@Idempotent()` interceptor fires on POST + PATCH.
 *   - `PrismaModule` — registered globally so `PrismaService` is in
 *     scope.
 *
 * No exports today — nothing outside this module consumes dispute
 * state directly. Cross-service reads (the admin tooling triage UI
 * — TS-128) land via the gateway BFF (TS-140) or via the
 * `booking.dispute_*` events on the bus (TS-142).
 */
@Module({
  controllers: [DisputesController],
  providers: [DisputesService],
})
export class DisputesModule {}
