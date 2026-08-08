import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { RedisHealthService } from './redis-health.service';

@Module({
  controllers: [HealthController],
  providers: [RedisHealthService],
})
export class HealthModule {}
