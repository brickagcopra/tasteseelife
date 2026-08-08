import { Module } from '@nestjs/common';

import { RelayModule } from '../relay/relay.module';
import { HealthController } from './health.controller';

/**
 * `/healthz` + `/readyz` endpoints. Depends on `RelayModule` for the
 * shared Postgres pool + Redis client tokens.
 */
@Module({
  imports: [RelayModule],
  controllers: [HealthController],
})
export class HealthModule {}
