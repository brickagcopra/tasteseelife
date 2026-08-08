import { Module } from '@nestjs/common';

import { AppConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AdminChartOfAccountsController } from './controllers/admin-chart-of-accounts.controller';
import { AdminDeferredRevenueController } from './controllers/admin-deferred-revenue.controller';
import { AdminJournalsController } from './controllers/admin-journals.controller';
import { AdminPeriodEventsController } from './controllers/admin-period-events.controller';
import { AdminTrialBalanceController } from './controllers/admin-trial-balance.controller';
import { AdminChartOfAccountsService } from './services/admin-chart-of-accounts.service';
import { AdminDeferredRevenueService } from './services/admin-deferred-revenue.service';
import { AdminJournalsService } from './services/admin-journals.service';
import { AdminPeriodEventsService } from './services/admin-period-events.service';
import { PausedBalanceGauge } from './services/paused-balance-gauge';
import { TrialBalanceService } from './services/trial-balance.service';

/**
 * Admin accounting module (TS-129 Slice 1 + TS-129-followup-1; PRD §10.8,
 * PDD §11.2, CLAUDE.md §6).
 *
 * Wires up four admin surfaces:
 *
 *   - `AdminJournalsController` — journal browser (list + detail).
 *     Closes TS-081-followup-7.
 *   - `AdminTrialBalanceController` — trial-balance summary
 *     (per-account aggregates with period scope).
 *   - `AdminPeriodEventsController` — per-period lifecycle event list.
 *     Closes TS-085-followup-7.
 *   - `AdminChartOfAccountsController` — chart-of-accounts retire/
 *     activate toggle (TS-129-followup-1).
 *   - `AdminDeferredRevenueController` — the paused-balance ops queue
 *     (TS-042-followup-3b2-followup-2a), plus `PausedBalanceGauge`, the
 *     observed stock counterpart to the pause/resume flow counter.
 *     The gauge lives here rather than beside `RecognitionMetrics` in
 *     `RevenueRecognitionModule` because it reads through this module's
 *     read service; the two instruments share a meter name so they land
 *     on one dashboard.
 *
 * All endpoints sit behind `AccessTokenGuard` → `SuperAdminRoleGuard`;
 * per-permission gating (`accounting:read` / `accounting:adjust`)
 * lands once `PermissionGuard` lifts to `packages/nest-auth`
 * (TS-052-followup-11). Today's `super_admin`-only gate is the
 * deliberate Slice 1 posture.
 *
 * The mutating surfaces (period close / reopen / generate, journal
 * post / reverse, manual adjustment) live in the existing
 * `JournalsModule` + `PeriodsModule` — this module ADDS read browsing
 * + the chart-of-accounts retire toggle on top, not replaces them.
 *
 * The shared `@Idempotent()` interceptor (used by the chart-of-accounts
 * PATCH endpoint) comes from the root AppModule's
 * `IdempotencyModule.forRoot(...)` — `IdempotencyModule` is `@Global()`,
 * so this module does not re-import it.
 */
@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [
    AdminJournalsController,
    AdminTrialBalanceController,
    AdminPeriodEventsController,
    AdminChartOfAccountsController,
    AdminDeferredRevenueController,
  ],
  providers: [
    AdminJournalsService,
    TrialBalanceService,
    AdminPeriodEventsService,
    AdminChartOfAccountsService,
    AdminDeferredRevenueService,
    PausedBalanceGauge,
  ],
})
export class AdminModule {}
