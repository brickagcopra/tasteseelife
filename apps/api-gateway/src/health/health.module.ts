import { Module } from '@nestjs/common';

import { ServiceRegistryModule } from '../modules/service-registry/service-registry.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ServiceRegistryModule],
  controllers: [HealthController],
})
export class HealthModule {}
