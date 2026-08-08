import { Module } from '@nestjs/common';

import { TargetingModule } from '../targeting/targeting.module';
import { SponsoredListingsController } from './controllers/sponsored-listings.controller';
import { SponsoredCampaignRepository } from './repositories/sponsored-campaign.repository';
import { SponsoredListingsMetrics } from './services/sponsored-listings-metrics';
import { SponsoredListingsService } from './services/sponsored-listings.service';
import { SPONSORED_LISTINGS_CLOCK_TOKEN, SystemClock } from './sponsored-listings.clock';

/**
 * Sponsored-listings delivery module (TS-218a; PRD §10.9; PDD §18.1, §18.3).
 *
 * Exposes the internal `POST /api/v1/internal/ads/sponsored-listings/resolve`
 * surface that `service-search` calls to fill the reserved sponsored slot(s) on
 * a provider-search results page. Imports `TargetingModule` for the
 * `TargetingService` audience evaluator (TS-273); pins the resolve endpoint
 * behind a shared-secret guard (the `ADS_INTERNAL_API_KEY` env). The system
 * clock is injected via `SPONSORED_LISTINGS_CLOCK_TOKEN` so flight-window
 * filtering + the response `resolvedAt` are deterministic under test.
 */
@Module({
  imports: [TargetingModule],
  controllers: [SponsoredListingsController],
  providers: [
    SponsoredListingsService,
    SponsoredCampaignRepository,
    SponsoredListingsMetrics,
    { provide: SPONSORED_LISTINGS_CLOCK_TOKEN, useClass: SystemClock },
  ],
  exports: [SponsoredListingsService],
})
export class SponsoredListingsModule {}
