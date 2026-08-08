import { Injectable, Logger } from '@nestjs/common';
import type { ProviderServiceAreasUpdated } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';

/**
 * Consumer handler for `provider.service_areas_updated` (TS-053-followup-3).
 *
 * A coverage edit (PUT / DELETE on `provider_service_areas`) changes the
 * representative `centroid` the discovery doc carries, so the search doc
 * must re-project for the family-portal's distance-sort search to reflect
 * the new geography.
 *
 * Like the sibling provider-event handlers, this is a thin shell: the
 * only field it reads from the payload is `providerId`. The actual
 * geometry / centroid is derived from the source-of-truth snapshot the
 * orchestrator fetches, so a stale event still produces a fresh
 * projection. The `areaCount` field on the event is intentionally
 * ignored here — the snapshot endpoint is the single source of truth.
 *
 * Returns `void` on success and throws on transport-layer failures; the
 * consumer SDK catches throws and retries on the next delivery cycle.
 * `invalid_provider_id` is absorbed by the orchestrator (terminal, no
 * retry) so the SDK XACKs a malformed event.
 */
@Injectable()
export class ProviderServiceAreasUpdatedHandler {
  private readonly logger = new Logger(ProviderServiceAreasUpdatedHandler.name);

  constructor(private readonly orchestrator: ProjectionOrchestratorService) {}

  async handle(args: HandleArgs<'provider.service_areas_updated'>): Promise<void> {
    const payload = args.payload as ProviderServiceAreasUpdated;
    this.logger.debug(
      {
        eventId: args.envelope.eventId,
        providerId: payload.providerId,
        areaCount: payload.areaCount,
      },
      'provider.service_areas_updated.handle',
    );
    await this.orchestrator.project(payload.providerId);
  }
}
