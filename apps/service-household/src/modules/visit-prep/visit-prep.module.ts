import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { VisitPrepInternalController } from './controllers/visit-prep.controller';
import { VisitPrepService } from './services/visit-prep.service';

/**
 * Visit-prep module (TS-208). Houses the read-only internal
 * `/api/v1/internal/seniors/:seniorId/prep-snapshot` endpoint that
 * api-gateway's BFF aggregator calls when assembling the provider-
 * facing visit prep checklist (PRD §7.3). Pinned by the
 * `HOUSEHOLD_VISIT_PREP_INTERNAL_API_KEY` shared-secret header.
 *
 * No exports — this module is internal-only.
 */
@Module({
  imports: [PrismaModule],
  controllers: [VisitPrepInternalController],
  providers: [VisitPrepService],
})
export class VisitPrepModule {}
