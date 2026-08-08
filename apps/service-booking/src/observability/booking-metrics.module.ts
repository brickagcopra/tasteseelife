import { Global, Module } from '@nestjs/common';

import { BookingMetrics } from './booking-metrics';

/**
 * Service-local global module exposing the domain `BookingMetrics`
 * instruments (TS-060-followup-4).
 *
 * The shared `@taste-and-see/nest-observability` package owns the boilerplate
 * (the `/metrics` scrape controller + the global `HttpMetricsInterceptor`),
 * but domain-metric classes stay service-local — they are domain-specific,
 * not boilerplate. `BookingMetrics` is injected by `BookingsService`; making
 * this module `@Global()` + exporting the provider lets the bookings feature
 * module (and any future sibling that records booking-domain metrics) inject
 * it without importing a module — the same pattern service-webhook's
 * `WebhookMetricsModule` (TS-041a-followup-4) established.
 */
@Global()
@Module({
  providers: [BookingMetrics],
  exports: [BookingMetrics],
})
export class BookingMetricsModule {}
