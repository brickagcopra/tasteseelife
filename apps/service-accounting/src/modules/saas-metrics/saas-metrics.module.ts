import { Module } from '@nestjs/common';

import { AdminSaasMetricsController } from './controllers/admin-saas-metrics.controller';
import { SaasMetricsController } from './controllers/saas-metrics.controller';
import { SaasMetricsService } from './services/saas-metrics.service';

/**
 * SaaS-metrics module (TS-260 + TS-266, PDD §11.2 + §23.2).
 *
 * Composition:
 *   - `SaasMetricsService` — computes the daily MRR / ARR / ARPU /
 *     movement / retention snapshot from the `deferred_revenue_balances`
 *     ledger primitive + the per-subscription MRR snapshot, persisting
 *     `saas_metrics_daily` + `saas_subscription_mrr_daily` in one
 *     transaction; and reads the daily series back for the dashboard
 *     (`listForDateRange`, TS-266).
 *   - `SaasMetricsController` — the internal (worker, shared-secret) +
 *     admin (AccessTokenGuard) compute endpoints.
 *   - `AdminSaasMetricsController` — the dashboard date-range read
 *     (`GET /api/v1/admin/accounting/saas-metrics`), `AccessTokenGuard`
 *     → `SuperAdminRoleGuard` (TS-266).
 *
 * No `JournalsModule` import — the metrics READ the ledger (the
 * deferred-revenue balances) rather than posting journals, so the only
 * dependency is the global `PrismaService` exported by `PrismaModule`.
 * `SaasMetricsService` is exported so the `accounting-metrics` worker +
 * other surfaces can compose it without re-importing the module shape.
 */
@Module({
  controllers: [SaasMetricsController, AdminSaasMetricsController],
  providers: [SaasMetricsService],
  exports: [SaasMetricsService],
})
export class SaasMetricsModule {}
