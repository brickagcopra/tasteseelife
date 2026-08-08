import { Module } from '@nestjs/common';

import { JanitorModule } from '../janitor/janitor.module';
import { HealthController } from './health.controller';

/**
 * `/healthz` + `/readyz` endpoints. Depends on `JanitorModule` for the
 * shared Postgres pool token.
 */
@Module({
  imports: [JanitorModule],
  controllers: [HealthController],
})
export class HealthModule {}
