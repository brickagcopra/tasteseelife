import { Module } from '@nestjs/common';

import { PeriodsController } from './controllers/periods.controller';
import { PeriodCalendarService } from './services/period-calendar.service';
import { PeriodLifecycleService } from './services/period-lifecycle.service';

/**
 * Periods module (TS-085).
 *
 * Composition:
 *   - `PeriodLifecycleService` — close + reopen with audit row writes
 *     and `source_event_id` idempotency.
 *   - `PeriodCalendarService` — ahead-of-time monthly period
 *     generation + list + get-by-name.
 *   - `PeriodsController` — five admin HTTP surfaces under
 *     `/api/v1/admin/periods`.
 *
 * Exports both services so future tasks (TS-260's full SaaS metrics +
 * period close + Stripe reconciliation, TS-129's admin browser) can
 * inject them without re-importing the module shape.
 */
@Module({
  controllers: [PeriodsController],
  providers: [PeriodLifecycleService, PeriodCalendarService],
  exports: [PeriodLifecycleService, PeriodCalendarService],
})
export class PeriodsModule {}
