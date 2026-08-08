import { Module } from '@nestjs/common';

import { ChartOfAccountsController } from './controllers/chart-of-accounts.controller';
import { ChartOfAccountsService } from './services/chart-of-accounts.service';

/**
 * Chart-of-accounts bounded module — owns the read-side of the
 * accounting catalog (TS-080).
 *
 * Exports `ChartOfAccountsService` so future cross-module flows (the
 * journal-posting service in TS-081 needs to resolve `code → id` at
 * post time; admin tooling in TS-127 reuses the same projection for
 * dropdowns) can reuse it without a module refactor.
 *
 * The `PrismaModule` is global, so this module only needs to declare
 * its own controllers + providers.
 */
@Module({
  controllers: [ChartOfAccountsController],
  providers: [ChartOfAccountsService],
  exports: [ChartOfAccountsService],
})
export class ChartOfAccountsModule {}
