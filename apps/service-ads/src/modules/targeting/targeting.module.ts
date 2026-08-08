import { Module } from '@nestjs/common';

import { AdTargetingRuleRepository } from './repositories/ad-targeting-rule.repository';
import { TargetingMetrics } from './services/targeting-metrics';
import { TargetingService } from './services/targeting.service';

/**
 * Targeting-rules engine module (TS-273; PRD §10.9; PDD §18.1).
 *
 * Exposes `TargetingService` — the server-side evaluator that decides
 * whether a campaign's persisted targeting rules match a delivery audience.
 * No HTTP surface of its own: the engine is consumed in-process by the
 * delivery path (TS-218 sponsored search slot / TS-275 impression capture)
 * and configured by the campaign admin UI (TS-271). `TargetingService` is
 * exported so those modules can inject it once they land.
 */
@Module({
  providers: [TargetingService, AdTargetingRuleRepository, TargetingMetrics],
  exports: [TargetingService],
})
export class TargetingModule {}
