import { Module } from '@nestjs/common';

import { InternalSharedSecretGuard } from '../../common/guards/internal-shared-secret.guard';

import { FeaturedPlacementsController } from './controllers/featured-placements.controller';
import { FeaturedPlacementsService } from './services/featured-placements.service';

/**
 * TS-207 featured-placements module. Wires the internal-shared-secret-pinned
 * admin controller + the cached active-placement resolver service. The
 * service is exported so the providers module's `InMemorySearchBackend` can
 * call `resolveActivePlacements()` from the search hot path — exactly the
 * shape `RankingConfigModule` follows for `RankingConfigService`.
 */
@Module({
  controllers: [FeaturedPlacementsController],
  providers: [FeaturedPlacementsService, InternalSharedSecretGuard],
  exports: [FeaturedPlacementsService],
})
export class FeaturedPlacementsModule {}
