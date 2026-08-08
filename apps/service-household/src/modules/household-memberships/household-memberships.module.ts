import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { HouseholdMembershipsInternalController } from './controllers/household-memberships.controller';
import { HouseholdMembershipsService } from './services/household-memberships.service';

/**
 * Household-memberships module (TS-505d2-followup-5). Houses the read-only
 * internal `/api/v1/internal/users/:userId/household-memberships` endpoint
 * the api-gateway calls to establish a request's household tenant scope
 * (CLAUDE.md §3.2). Pinned by the
 * `HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY` shared-secret header.
 *
 * No exports — this module is internal-only.
 */
@Module({
  imports: [PrismaModule],
  controllers: [HouseholdMembershipsInternalController],
  providers: [HouseholdMembershipsService],
})
export class HouseholdMembershipsModule {}
