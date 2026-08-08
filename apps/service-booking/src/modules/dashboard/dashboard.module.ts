import { Module } from '@nestjs/common';

import { FamilyDashboardController } from './controllers/family-dashboard.controller';
import { FamilyDashboardService } from './services/family-dashboard.service';

/**
 * Family peace-of-mind dashboard bounded module (TS-230).
 *
 * Composition:
 *   - `FamilyDashboardController` — one read endpoint
 *     (`GET /api/v1/bookings/dashboard/me`) resolving the household
 *     from the token `tenantScope`.
 *   - `FamilyDashboardService` — the read-side aggregate (windowed
 *     upcoming list + cursor-paginated completed-visit history with
 *     batched visit-note summaries).
 *
 * Depends on:
 *   - `PrismaModule` — registered globally so `PrismaService` is in
 *     scope.
 *
 * No exports — nothing outside this module consumes the dashboard
 * aggregate directly; the gateway BFF (TS-230) proxies the HTTP
 * surface. Read-only, so no `IdempotencyModule` / `OutboxModule`
 * dependency.
 */
@Module({
  controllers: [FamilyDashboardController],
  providers: [FamilyDashboardService],
})
export class DashboardModule {}
