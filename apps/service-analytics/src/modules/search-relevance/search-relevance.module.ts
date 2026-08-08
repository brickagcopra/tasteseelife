import { Module } from '@nestjs/common';

import { AdminSearchRelevanceController } from './controllers/admin-search-relevance.controller';
import { SearchRelevanceController } from './controllers/search-relevance.controller';
import { SearchRelevanceReadService } from './services/search-relevance-read.service';
import { SearchRelevanceService } from './services/search-relevance.service';

/**
 * Search-relevance aggregation + dashboard-read module (TS-217-prep-3b
 * compute; TS-217a read; PDD §23.1/§23.2).
 *
 * Composition:
 *   - `SearchRelevanceService` — reads the raw `search_events` /
 *     `booking_created_events` landing tables for a UTC-day window and writes
 *     the `search_relevance_daily` / `search_query_daily` / `search_sort_daily`
 *     / `search_click_position_daily` marts, stamping one
 *     `analytics_aggregation_runs` row per run.
 *   - `SearchRelevanceController` — the internal (worker, shared-secret) +
 *     admin (AccessTokenGuard) compute endpoints.
 *   - `SearchRelevanceReadService` — the read-side inverse: reads the marts
 *     for the web-admin dashboard (TS-217a). A separate provider so the heavy
 *     compute service stays focused.
 *   - `AdminSearchRelevanceController` — the admin dashboard read endpoints
 *     (`AccessTokenGuard` → `SuperAdminRoleGuard`).
 *
 * The only dependency is the global `PrismaService` exported by `PrismaModule`.
 * `SearchRelevanceService` is exported so the nightly worker path can compose
 * it; `SearchRelevanceReadService` stays internal to the module.
 */
@Module({
  controllers: [SearchRelevanceController, AdminSearchRelevanceController],
  providers: [SearchRelevanceService, SearchRelevanceReadService],
  exports: [SearchRelevanceService],
})
export class SearchRelevanceModule {}
