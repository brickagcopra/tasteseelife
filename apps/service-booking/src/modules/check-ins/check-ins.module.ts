import { Module } from '@nestjs/common';

import { LifecycleModule } from '../lifecycle/lifecycle.module';
import { CheckInsController } from './controllers/check-ins.controller';
import { CheckInsService } from './services/check-ins.service';

/**
 * Booking check-ins bounded module (TS-063; PRD §7.4 + PDD §9.2).
 *
 * Composition:
 *   - `CheckInsController` — two HTTP endpoints (POST record + GET
 *     list) under `/api/v1/bookings/:bookingId/check-ins`.
 *   - `CheckInsService` — atomic single-row insert + booking status
 *     update + outbox event append (`booking.in_progress` or
 *     `booking.completed`) inside one Prisma `$transaction`.
 *
 * Depends on:
 *   - `LifecycleModule` (TS-060) — exports `BookingLifecycleService`
 *     for defence-in-depth transition validation.
 *   - `OutboxModule` — registered globally in `AppModule.forRoot` so
 *     the injected `OutboxService` is in scope.
 *   - `IdempotencyModule` — registered globally in `AppModule.forRoot`
 *     so the `@Idempotent()` interceptor fires on the write endpoint.
 *   - `PrismaModule` — registered globally so `PrismaService` is in
 *     scope.
 *
 * No exports today — nothing outside this module consumes check-in
 * state directly. Cross-service reads (the family-portal "provider
 * arrived" badge) land via the gateway BFF (TS-140) or via the
 * booking.* events on the bus (TS-142).
 */
@Module({
  imports: [LifecycleModule],
  controllers: [CheckInsController],
  providers: [CheckInsService],
})
export class CheckInsModule {}
