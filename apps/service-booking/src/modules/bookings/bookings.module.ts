import { Module } from '@nestjs/common';

import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { SubjectHoldsModule } from '../subject-holds/subject-holds.module';
import { TierGatingModule } from '../tier-gating/tier-gating.module';
import { BookingsController } from './controllers/bookings.controller';
import { BookingsListService } from './services/bookings-list.service';
import { BookingsService } from './services/bookings.service';

/**
 * Bookings bounded module (TS-060-followup-1).
 *
 * Composition:
 *   - `BookingsController` — three HTTP endpoints (create / transition
 *     status / get-by-id).
 *   - `BookingsService` — row mutation + outbox event emission inside
 *     the same Prisma transaction (PDD §7.3, CLAUDE.md §5.3).
 *
 * Depends on:
 *   - `LifecycleModule` (TS-060) — exports `BookingLifecycleService`
 *     for the transition-validation step.
 *   - `OutboxModule` — registered globally in `AppModule.forRoot` so
 *     the injected `OutboxService` is in scope.
 *   - `IdempotencyModule` — registered globally in `AppModule.forRoot`
 *     so the `@Idempotent()` interceptor fires on the write
 *     endpoints.
 *   - `PrismaModule` — registered globally in `AppModule` so
 *     `PrismaService` is in scope.
 *
 * No exports today — nothing outside this module consumes booking
 * state directly. Cross-service reads land via the gateway BFF
 * (TS-140) or via the booking.* events on the bus (TS-142).
 */
@Module({
  // TS-304 — `SubjectHoldsModule` exports the trust & safety hold screen
  // `createBooking` consults before any side effect.
  imports: [LifecycleModule, TierGatingModule, SubjectHoldsModule],
  controllers: [BookingsController],
  providers: [BookingsService, BookingsListService],
  exports: [BookingsService],
})
export class BookingsModule {}
