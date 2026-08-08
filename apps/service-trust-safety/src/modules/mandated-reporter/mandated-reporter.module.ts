import { Module } from '@nestjs/common';

import { MandatedReporterJurisdictionsController } from './controllers/jurisdictions.controller';
import { MandatedReporterController } from './controllers/mandated-reporter.controller';
import { MandatedReporterRepository } from './repositories/mandated-reporter.repository';
import { MandatedReporterService } from './services/mandated-reporter.service';

/**
 * Mandated-reporter bounded module (TS-303a) — the statutory pathway for
 * suspected elder abuse (PRD §10.14, §11.4; PDD §16.1, §16.4; CLAUDE.md §12).
 *
 * TS-303a shipped the durable half and the domain rules; TS-303b added
 * `MandatedReporterController` — the ops surface (open / advance / read),
 * gated on `trust_safety:write` at the gateway and re-checked in the
 * handler, emitting `audit.action_recorded` inside the mutation transaction.
 * The web-admin console lands in TS-303c.
 *
 * `MandatedReporterService` is exported so `IncidentsService.resolveIncident`
 * can call `assertIncidentResolvable` — the never-auto-close gate.
 */
@Module({
  controllers: [MandatedReporterController, MandatedReporterJurisdictionsController],
  providers: [MandatedReporterRepository, MandatedReporterService],
  exports: [MandatedReporterService],
})
export class MandatedReporterModule {}
