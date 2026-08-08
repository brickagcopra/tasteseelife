import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { WellnessSummaryInternalController } from './controllers/wellness-summary.controller';
import { WellnessSummaryService } from './services/wellness-summary.service';

/**
 * Wellness-summary module (TS-235). Houses the read-only internal
 * `/api/v1/internal/wellness-summary/households` endpoint the monthly
 * wellness-summary worker calls to walk the active-household population
 * (each household's active seniors + their `notes` consent flag + the
 * active recipients to notify). Pinned by the
 * `HOUSEHOLD_WELLNESS_SUMMARY_INTERNAL_API_KEY` shared-secret header.
 *
 * No exports — this module is internal-only. Like the TS-208 visit-prep
 * module it does NOT add any model to `unscopedModels`: the controller
 * wraps its handler in `runWithoutTenantContext` and reads the scoped
 * `Household` / `Senior` / `SeniorConsent` / `HouseholdMember` models
 * inside that exempt frame.
 */
@Module({
  imports: [PrismaModule],
  controllers: [WellnessSummaryInternalController],
  providers: [WellnessSummaryService],
})
export class WellnessSummaryModule {}
