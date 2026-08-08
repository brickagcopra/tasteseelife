import { Module } from '@nestjs/common';

import { InternalSharedSecretGuard } from '../../common/guards/internal-shared-secret.guard';

import { RankingConfigController } from './controllers/ranking-config.controller';
import { RankingConfigService } from './services/ranking-config.service';

/**
 * TS-211 ranking-config module. Wires the internal-shared-secret-pinned
 * admin controller + the cached resolver service. The service is
 * exported so the providers module's `InMemorySearchBackend` can call
 * `resolveWeights(...)` from the search hot path.
 */
@Module({
  controllers: [RankingConfigController],
  providers: [RankingConfigService, InternalSharedSecretGuard],
  exports: [RankingConfigService],
})
export class RankingConfigModule {}
