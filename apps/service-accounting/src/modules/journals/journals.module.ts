import { Module } from '@nestjs/common';

import { JournalsController } from './controllers/journals.controller';
import { AccountingPeriodService } from './services/accounting-period.service';
import { JournalPostingService } from './services/journal-posting.service';

/**
 * Journal-posting module (TS-081).
 *
 * Composition:
 *   - `JournalPostingService` — public write surface (post,
 *     postManualAdjustment, reverse).
 *   - `AccountingPeriodService` — lazy monthly period
 *     resolution (retired by TS-085's explicit calendar
 *     generator).
 *   - `JournalsController` — three HTTP write endpoints
 *     (`POST /api/v1/internal/journals`,
 *     `POST /api/v1/admin/journals/manual-adjustment`,
 *     `POST /api/v1/admin/journals/:journalId/reverse`).
 *
 * Exports `JournalPostingService` so TS-082 (revenue
 * recognition), TS-083 (booking commissions), TS-084 (coupon
 * contra-revenue + refunds), and TS-085 (period close) can
 * inject it without re-importing the module shape.
 */
@Module({
  controllers: [JournalsController],
  providers: [JournalPostingService, AccountingPeriodService],
  exports: [JournalPostingService, AccountingPeriodService],
})
export class JournalsModule {}
