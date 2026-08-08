import { Module } from '@nestjs/common';

import { ProvidersModule } from '../modules/providers/providers.module';

import { HealthController } from './health.controller';

/**
 * Health / readiness probes.
 *
 * Imports `ProvidersModule` for `SEARCH_BACKEND_TOKEN` (TS-506).
 * `HealthController` injects the search backend so readiness reflects
 * whether this pod can actually answer a query — but the token is
 * declared and exported by `ProvidersModule`, and this module imported
 * nothing, so the controller could not be constructed and the process
 * died in the injector before binding a port. A health module is exactly
 * where that failure costs most: nothing survived to report it.
 */
@Module({
  imports: [ProvidersModule],
  controllers: [HealthController],
})
export class HealthModule {}
