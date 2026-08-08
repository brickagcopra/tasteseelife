import { Module } from '@nestjs/common';

import { SeniorConsentController } from './controllers/senior-consent.controller';
import { SeniorConsentService } from './services/senior-consent.service';

/**
 * Senior family-observability consent module (TS-238).
 *
 * Owns the per-senior consent map — four surface-visibility booleans
 * (photos / notes / location / health), default opt-out, that gate what
 * a `family_observer` household member may see (PRD §6.4, CLAUDE.md §12).
 *
 * Exports the service so in-service consumers can consult the map. The
 * first consumer is `IntakeService` (TS-238 wires the `health` surface
 * live — a family observer's intake read is masked unless the senior has
 * consented to share health); the cross-service surfaces (photos →
 * TS-232, notes / location → service-booking) consult the published
 * `GET /api/v1/seniors/:seniorId/consent` read via the gateway when their
 * owning tasks land.
 */
@Module({
  controllers: [SeniorConsentController],
  providers: [SeniorConsentService],
  exports: [SeniorConsentService],
})
export class SeniorConsentModule {}
