import { Controller, Get, HttpCode, HttpStatus, Query, UseGuards } from '@nestjs/common';
import {
  ListSaasMetricsResponseSchema,
  SaasMetricsRangeQuerySchema,
  type ListSaasMetricsResponse,
  type SaasMetricsRangeQuery,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { SaasMetricsService } from '../services/saas-metrics.service';

/**
 * SaaS-metrics dashboard read endpoint (TS-266; PRD §10.1, PDD §23.2).
 *
 *   GET /api/v1/admin/accounting/saas-metrics?from=&to=
 *
 * Returns the daily SaaS-metrics series (MRR / ARR / ARPU / movement
 * decomposition / NRR / GRR) in ascending `metricDate` order for the
 * admin dashboard. Both bounds optional + inclusive; the service caps the
 * row count at `SAAS_METRICS_RANGE_MAX_ROWS` and echoes the effective
 * window.
 *
 * Authorisation posture mirrors the sibling accounting read
 * (`AdminTrialBalanceController`): `AccessTokenGuard` → `SuperAdminRoleGuard`.
 * Per-permission gating (`accounting:read`) lands once `PermissionGuard`
 * lifts to `packages/nest-auth` (TS-052-followup-11) — twin of the
 * Slice-1 accounting posture (TS-129). Read-only, so no `@Idempotent()`.
 *
 * `AccessTokenGuard` seeds a scoped tenant frame from the access-token
 * claims, so the read needs no `runWithoutTenantContext` wrap — `saas_metrics_daily`
 * is platform-wide ops data read under that frame, same as the admin
 * compute trigger in `SaasMetricsController`.
 */
@Controller()
@UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
export class AdminSaasMetricsController {
  constructor(private readonly metrics: SaasMetricsService) {}

  @Get('api/v1/admin/accounting/saas-metrics')
  @HttpCode(HttpStatus.OK)
  async list(
    @Query(new ZodValidationPipe(SaasMetricsRangeQuerySchema))
    query: SaasMetricsRangeQuery,
  ): Promise<ListSaasMetricsResponse> {
    const result = await this.metrics.listForDateRange({
      ...(query.from !== undefined && { from: toUtcMidnight(query.from) }),
      ...(query.to !== undefined && { to: toUtcMidnight(query.to) }),
    });
    return ListSaasMetricsResponseSchema.parse(result);
  }
}

/** Parse a `YYYY-MM-DD` calendar-date string to its midnight-UTC `Date`. */
function toUtcMidnight(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}
