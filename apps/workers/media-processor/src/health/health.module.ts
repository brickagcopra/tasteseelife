import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * `/healthz` + `/readyz` endpoints. No dependencies — the media-processor
 * owns no database / Redis (see `HealthController`).
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
