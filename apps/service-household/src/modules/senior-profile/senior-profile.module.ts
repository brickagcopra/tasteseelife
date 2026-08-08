import { Module } from '@nestjs/common';

import { SeniorPreferencesController } from './controllers/senior-preferences.controller';
import { SeniorPreferencesService } from './services/senior-preferences.service';

/**
 * Senior memory profile module (TS-033).
 *
 * Owns the per-senior preferences key/value store — favourite-childhood-
 * food, regional-tradition, comfort-food, Sunday-ritual cues that give
 * a chef the personal hooks PRD §6.5 calls for. Plain-column storage
 * rationale lives on the SeniorPreference Prisma model.
 *
 * Exports the service so future cross-module flows (booking-svc visit
 * prep "highlight 3-5 entries for the chef", admin tooling reads,
 * audit-svc lookups) can reuse it.
 */
@Module({
  controllers: [SeniorPreferencesController],
  providers: [SeniorPreferencesService],
  exports: [SeniorPreferencesService],
})
export class SeniorProfileModule {}
