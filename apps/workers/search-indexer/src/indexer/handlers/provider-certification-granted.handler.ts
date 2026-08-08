import { Injectable, Logger } from '@nestjs/common';
import type { ProviderCertificationGranted } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';

/**
 * Consumer handler for `provider.certification_granted` (TS-053).
 *
 * Same orchestration as `ProviderTierChangedHandler` — delegates to
 * the projection orchestrator with the event's `providerId`. The
 * orchestrator re-fetches the snapshot so the doc reflects whatever
 * certifications are CURRENTLY active, irrespective of which one
 * just landed.
 */
@Injectable()
export class ProviderCertificationGrantedHandler {
  private readonly logger = new Logger(ProviderCertificationGrantedHandler.name);

  constructor(private readonly orchestrator: ProjectionOrchestratorService) {}

  async handle(args: HandleArgs<'provider.certification_granted'>): Promise<void> {
    const payload = args.payload as ProviderCertificationGranted;
    this.logger.debug(
      {
        eventId: args.envelope.eventId,
        providerId: payload.providerId,
        certificationCode: payload.certificationCode,
      },
      'provider.certification_granted.handle',
    );
    await this.orchestrator.project(payload.providerId);
  }
}
