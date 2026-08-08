import { Injectable, Logger } from '@nestjs/common';
import type { ProviderCertificationRevoked } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';

/**
 * Consumer handler for `provider.certification_revoked` (TS-053).
 *
 * Same orchestration as the two siblings — delegates to the
 * projection orchestrator with the event's `providerId`.
 */
@Injectable()
export class ProviderCertificationRevokedHandler {
  private readonly logger = new Logger(ProviderCertificationRevokedHandler.name);

  constructor(private readonly orchestrator: ProjectionOrchestratorService) {}

  async handle(args: HandleArgs<'provider.certification_revoked'>): Promise<void> {
    const payload = args.payload as ProviderCertificationRevoked;
    this.logger.debug(
      {
        eventId: args.envelope.eventId,
        providerId: payload.providerId,
        certificationCode: payload.certificationCode,
      },
      'provider.certification_revoked.handle',
    );
    await this.orchestrator.project(payload.providerId);
  }
}
