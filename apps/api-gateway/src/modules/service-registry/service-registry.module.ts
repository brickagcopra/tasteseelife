import { Module } from '@nestjs/common';

import { AuthContextModule } from '../auth-context/auth-context.module';
import { DownstreamHttpClient } from './services/downstream-http-client';
import { DownstreamMetrics } from './services/downstream-metrics';
import { ServiceRegistry } from './services/service-registry';

/**
 * Service registry + downstream HTTP client (TS-140).
 *
 * Exports both so any proxy / aggregation controller can declare them
 * as constructor dependencies. The registry is the table that maps
 * `DownstreamServiceName` → base URL; the client is the typed `fetch`
 * wrapper that mints trust headers + applies timeouts + classifies
 * the response into a discriminated `DownstreamResult`.
 */
@Module({
  imports: [AuthContextModule],
  // TS-140-followup-4 — `DownstreamMetrics` is provider-only: the client is
  // its single consumer, and every call in the gateway goes through it.
  providers: [ServiceRegistry, DownstreamHttpClient, DownstreamMetrics],
  exports: [ServiceRegistry, DownstreamHttpClient],
})
export class ServiceRegistryModule {}
