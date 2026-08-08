import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ListSearchRelevanceDailyResponseSchema,
  SearchRelevanceDayDetailResponseSchema,
  SearchRelevanceDetailQuerySchema,
  SearchRelevanceRangeQuerySchema,
  type ListSearchRelevanceDailyResponse,
  type SearchRelevanceDayDetailResponse,
  type SearchRelevanceDetailQuery,
  type SearchRelevanceRangeQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { SearchRelevanceReadService } from '../services/search-relevance-read.service';

/**
 * Search-relevance dashboard read endpoints (TS-217a; PRD §10.1, PDD §23.1/§23.2).
 *
 *   GET /api/v1/admin/analytics/search-relevance/summary?from=&to=
 *   GET /api/v1/admin/analytics/search-relevance/detail?date=
 *
 * The `summary` read returns the per-day `search_relevance_daily` series
 * (totals + zero-result rate + approximate & precise conversion ppm) in
 * ascending `metricDate` order for the dashboard's trend chart + headline
 * KPIs. The `detail` read returns one UTC day's drill-down (top queries,
 * zero-result queries, searches-per-sort, CTR-by-position).
 *
 * Authorisation posture mirrors the SaaS-metrics dashboard read
 * (`AdminSaasMetricsController`, TS-266): `AccessTokenGuard` →
 * `SuperAdminRoleGuard`. Per-permission gating (`analytics:read`) lands once
 * `PermissionGuard` lifts to `packages/nest-auth` (twin of TS-217-prep-3b-followup-1).
 * Read-only, so no `@Idempotent()`.
 *
 * `AccessTokenGuard` seeds a scoped tenant frame from the access-token claims,
 * so the reads need no `runWithoutTenantContext` wrap — the marts are
 * platform-wide `unscopedModels`, read under that frame (same as the admin
 * compute trigger in `SearchRelevanceController`).
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminSearchRelevanceController {
  constructor(private readonly read: SearchRelevanceReadService) {}

  @Get('api/v1/admin/analytics/search-relevance/summary')
  @HttpCode(HttpStatus.OK)
  async listSummaries(
    @Query(new ZodValidationPipe(SearchRelevanceRangeQuerySchema))
    query: SearchRelevanceRangeQuery,
  ): Promise<ListSearchRelevanceDailyResponse> {
    const result = await this.read.listDailySummaries({
      ...(query.from !== undefined && { from: toUtcMidnight(query.from) }),
      ...(query.to !== undefined && { to: toUtcMidnight(query.to) }),
    });
    return ListSearchRelevanceDailyResponseSchema.parse(result);
  }

  @Get('api/v1/admin/analytics/search-relevance/detail')
  @HttpCode(HttpStatus.OK)
  async getDetail(
    @Query(new ZodValidationPipe(SearchRelevanceDetailQuerySchema))
    query: SearchRelevanceDetailQuery,
  ): Promise<SearchRelevanceDayDetailResponse> {
    const result = await this.read.getDayDetail(toUtcMidnight(query.date));
    return SearchRelevanceDayDetailResponseSchema.parse(result);
  }
}

/** Parse a `YYYY-MM-DD` calendar-date string to its midnight-UTC `Date`. */
function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
