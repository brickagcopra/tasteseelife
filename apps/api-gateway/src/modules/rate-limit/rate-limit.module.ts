import { Module } from '@nestjs/common';

import { RateLimitGuard } from './guards/rate-limit.guard';
import { RateLimitMetrics } from './services/rate-limit-metrics';
import { RateLimitService } from './services/rate-limit.service';

/**
 * Sliding-window rate-limit module (TS-140 / CLAUDE.md §3.1, §3.7).
 *
 * Exports the service + guard for controller-level binding. The guard
 * is provider-only (not registered as `APP_GUARD`) so controllers can
 * compose the order with `AccessTokenGuard` explicitly via
 * `@UseGuards(...)` — the auth guard MUST run first on protected
 * routes so the per-user key resolves correctly.
 */
@Module({
  providers: [RateLimitService, RateLimitGuard, RateLimitMetrics],
  // `RateLimitMetrics` is exported even though the guard is its only consumer
  // (TS-140-followup-4 originally kept it provider-only for exactly that
  // reason). **A `@UseGuards(RateLimitGuard)` guard is instantiated in the
  // module that declares the controller, not in the module that declares the
  // guard** — so every one of the guard's own dependencies has to be
  // resolvable from the consumer's context, which for a non-`@Global()` module
  // means exported. Without this the gateway does not boot at all: the very
  // first controller Nest loads throws `UnknownDependenciesException` for
  // `RateLimitMetrics at index [2]`. This is the same shape as ADR-0005 (a
  // module's own dependencies are resolved where the provider is *declared*,
  // and `@Global()`/`exports` govern only where it is *consumable*), seen from
  // the other side: here the guard is declared centrally and constructed
  // remotely. Found by the TS-505 E2E fleet, which was the first thing to run
  // the gateway as a process.
  exports: [RateLimitService, RateLimitGuard, RateLimitMetrics],
})
export class RateLimitModule {}
