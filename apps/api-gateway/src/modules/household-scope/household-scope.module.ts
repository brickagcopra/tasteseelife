import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { ServiceRegistryModule } from '../service-registry/service-registry.module';
import { HouseholdScopeInterceptor } from './household-scope.interceptor';
import { HouseholdScopeResolver } from './services/household-scope.resolver';

/**
 * Household-scope module (TS-505d2-followup-5).
 *
 * Registers `HouseholdScopeInterceptor` as an `APP_INTERCEPTOR` so every
 * authenticated request gets its household `tenantScope` established from
 * the actor's active memberships before the trust envelope is signed.
 * Global registration is the point: the thirteen household-scoped handlers
 * live behind eight different proxy controllers, and a per-controller
 * opt-in is how one of them would be missed — the exact shape of
 * TS-505d-prep's 33 permanently-400 routes and TS-505d2-followup-4's
 * eleven unreachable downstreams.
 *
 * `ServiceRegistryModule` supplies `DownstreamHttpClient`; `RedisModule`
 * is `@Global()` so the resolver's cache client needs no import here.
 *
 * Registration ORDER matters and is why this module is imported after
 * `ServiceRegistryModule` but before `GatewayRoutesModule` in `AppModule`
 * — Nest runs global interceptors in module-registration order, and the
 * scope must be settled before any route-level interceptor reads the
 * context.
 */
@Module({
  imports: [ServiceRegistryModule],
  providers: [
    HouseholdScopeResolver,
    {
      provide: APP_INTERCEPTOR,
      useClass: HouseholdScopeInterceptor,
    },
  ],
  exports: [HouseholdScopeResolver],
})
export class HouseholdScopeModule {}
