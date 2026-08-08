import { Module } from '@nestjs/common';

import { HouseholdAccessController } from './controllers/household-access.controller';
import { AccessInstructionsCipherService } from './services/access-instructions-cipher.service';
import { HouseholdAccessService } from './services/household-access.service';

/**
 * Household access-instructions module (TS-032).
 *
 * Owns the encrypted "how does a provider get into this home" payload —
 * door codes, key locations, alarm codes, parking instructions, doorman
 * info, pet info, general notes. Storage rationale lives on the cipher
 * service + the `household.households` columns added by the TS-032
 * migration.
 *
 * Exports both services so future cross-module flows (e.g. an admin-
 * side read, or a backfill worker that rotates the access key) can
 * consume them without a refactor.
 */
@Module({
  controllers: [HouseholdAccessController],
  providers: [HouseholdAccessService, AccessInstructionsCipherService],
  exports: [HouseholdAccessService, AccessInstructionsCipherService],
})
export class HouseholdAccessModule {}
