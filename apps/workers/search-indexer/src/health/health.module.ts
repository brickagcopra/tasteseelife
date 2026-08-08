import { Module } from '@nestjs/common';

import { IndexerModule } from '../indexer/indexer.module';
import { HealthController } from './health.controller';

/**
 * `/healthz` + `/readyz` endpoints. Depends on `IndexerModule` for
 * the Redis client provider token.
 */
@Module({
  imports: [IndexerModule],
  controllers: [HealthController],
})
export class HealthModule {}
