import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/** `/healthz` + `/readyz` endpoints. No dependencies — see the controller. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
