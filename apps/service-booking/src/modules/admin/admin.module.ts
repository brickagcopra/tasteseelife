import { Module } from '@nestjs/common';

import { AdminBookingsController } from './controllers/admin-bookings.controller';
import { AdminBookingsService } from './services/admin-bookings.service';

/**
 * Admin bounded module (TS-128 Slice 1; PRD §10.5).
 *
 * Slice 1 ships the read-only `GET /api/v1/admin/bookings` +
 * `GET /api/v1/admin/bookings/:id` surfaces. Mutations (manual
 * concierge booking creation, cancel/refund, dispute resolution),
 * provider tier + commission management, featured-placement
 * scheduling, service-catalog management, audit-event emission,
 * Playwright E2E, OTel + Prometheus, and OpenAPI generator
 * registration arrive in subsequent TS-128 follow-ups.
 *
 * No imports — the service depends only on `PrismaService` which is a
 * global provider via `PrismaModule`. No exports today — nothing
 * outside this module consumes admin state directly.
 */
@Module({
  controllers: [AdminBookingsController],
  providers: [AdminBookingsService],
})
export class AdminModule {}
