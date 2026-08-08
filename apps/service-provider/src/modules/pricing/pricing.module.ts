import { Module } from '@nestjs/common';

import { ProviderPricingController } from './controllers/provider-pricing.controller';
import { ProviderPricingMetrics } from './services/provider-pricing-metrics';
import { ProviderPricingService } from './services/provider-pricing.service';

/**
 * Pricing bounded module (TS-204) — owns the self-service pricing-band
 * editor surface (`PUT /api/v1/providers/:providerId/pricing`) + the
 * `provider.pricing_updated` outbox emission.
 *
 * Composition:
 *   - `ProviderPricingController` — HTTP boundary; validates with the
 *     contract-side Zod schemas + If-Match / Idempotency-Key headers.
 *   - `ProviderPricingService` — owns the band-validated transactional
 *     update + outbox-event emission. Exported so the future
 *     booking-quote read (TS-204-followup-1) + in-cluster admin tooling
 *     can consume the materialised row without an HTTP round-trip.
 *
 * The per-tier band lives in the contract layer's
 * `PROVIDER_PRICING_BANDS` (shared with the web-provider editor). A
 * configurable `service_catalog`-backed band lands with
 * TS-204-followup-2 / TS-060-followup-2; the module wiring is unchanged
 * when that arrives — only the band source moves.
 *
 * `ProviderPricingMetrics` (TS-204-followup-4) registers the pricing
 * Prometheus instruments; Nest injects it into `ProviderPricingService`
 * (which also carries a no-op default so the two-arg unit-test call
 * sites stay green). The HTTP root span + `/metrics` exposition are
 * already wired by the service-provider observability base
 * (TS-050-followup-1).
 */
@Module({
  controllers: [ProviderPricingController],
  providers: [ProviderPricingService, ProviderPricingMetrics],
  exports: [ProviderPricingService],
})
export class PricingModule {}
