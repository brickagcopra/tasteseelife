import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * `/healthz` + `/readyz` endpoints. The worker has no datastore, so the
 * module wires only the controller.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
