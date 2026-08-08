import { Module } from '@nestjs/common';

import { SeniorAlertPreferencesController } from './controllers/senior-alert-preferences.controller';
import { SeniorAlertPreferencesService } from './services/senior-alert-preferences.service';

/**
 * Per-(senior × family-member) alert subscription module (TS-234).
 *
 * Owns the alert-subscription map — three alert-type booleans
 * (missedVisit / concerningObservation / emergencyFlag) per
 * (senior × member). Each household member configures their own
 * subscription; defaults are operational + safety on, observation off
 * (PRD §6.4, PDD §12.3).
 *
 * Exports the service so the deferred alert-dispatch consumers can read a
 * senior's subscriber set at emission time. Today there are no
 * in-service consumers — the missed-visit / observation-anomaly /
 * emergency-flag detectors that fan out to subscribed members
 * (TS-234 follow-ups + TS-235 / TS-236) consult this map (and the senior's
 * `notes` consent for the observation alert) when their owning tasks land.
 */
@Module({
  controllers: [SeniorAlertPreferencesController],
  providers: [SeniorAlertPreferencesService],
  exports: [SeniorAlertPreferencesService],
})
export class SeniorAlertPreferencesModule {}
