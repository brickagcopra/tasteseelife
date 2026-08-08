import { Module } from '@nestjs/common';

import { BookingLifecycleService } from './booking-lifecycle.service';

/**
 * Lifecycle module — exposes `BookingLifecycleService` to the rest of
 * the application.
 *
 * Today the service is consumed only by the unit suite; once
 * TS-060-followup-1's `BookingsService` lands (the orchestration layer
 * that owns `bookings` row mutations + outbox event emission), it
 * imports this module to gate every UPDATE on a legal transition.
 *
 * Kept as its own module rather than co-located with the future
 * `bookings` module because the lifecycle logic is the durable kernel
 * — the orchestration around it can be replaced (a future event-
 * sourced rewrite, a sibling read model) without touching the
 * transition matrix.
 */
@Module({
  providers: [BookingLifecycleService],
  exports: [BookingLifecycleService],
})
export class LifecycleModule {}
