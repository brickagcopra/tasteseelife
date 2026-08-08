import { Global, Module } from '@nestjs/common';

import { SubscriptionMetrics } from './subscription-metrics';

/**
 * Service-local global module exposing the domain `SubscriptionMetrics`
 * instruments (TS-041b-followup-3a).
 *
 * The shared `@taste-and-see/nest-observability` package owns the boilerplate
 * (the `/metrics` scrape controller + the global `HttpMetricsInterceptor`),
 * but domain-metric classes stay service-local. `@Global()` + exported so the
 * outbox-consumer handlers (and any future feature module recording
 * subscription-domain metrics) inject it without an `imports:` line — the same
 * pattern `WebhookMetricsModule` and `BookingMetricsModule` established.
 */
@Global()
@Module({
  providers: [SubscriptionMetrics],
  exports: [SubscriptionMetrics],
})
export class SubscriptionMetricsModule {}
