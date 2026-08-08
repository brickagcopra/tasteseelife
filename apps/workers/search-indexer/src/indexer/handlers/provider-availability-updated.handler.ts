import { Injectable, Logger } from '@nestjs/common';
import type { ProviderAvailabilityUpdated } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';

/**
 * Consumer handler for `provider.availability_updated` (TS-053-followup-5a).
 *
 * An availability edit (PUT / DELETE on the recurring-window or
 * date-exclusion tables) changes the next-7-days `availabilitySummary`
 * the discovery doc carries, so the search doc must re-project for the
 * family-portal's "available this week" facet to reflect the new
 * schedule. Without this subscription an availability edit silently
 * drifts the index.
 *
 * Like the sibling provider-event handlers, this is a thin shell: the
 * only field it reads from the payload is `providerId`. The actual
 * schedule is derived from the source-of-truth snapshot the
 * orchestrator fetches, so a stale event still produces a fresh
 * projection. The `windowCount` / `exceptionCount` fields on the event
 * are intentionally ignored here — the snapshot endpoint is the single
 * source of truth.
 *
 * Returns `void` on success and throws on transport-layer failures; the
 * consumer SDK catches throws and retries on the next delivery cycle.
 * `invalid_provider_id` is absorbed by the orchestrator (terminal, no
 * retry) so the SDK XACKs a malformed event.
 */
@Injectable()
export class ProviderAvailabilityUpdatedHandler {
  private readonly logger = new Logger(ProviderAvailabilityUpdatedHandler.name);

  constructor(private readonly orchestrator: ProjectionOrchestratorService) {}

  async handle(args: HandleArgs<'provider.availability_updated'>): Promise<void> {
    const payload = args.payload as ProviderAvailabilityUpdated;
    this.logger.debug(
      {
        eventId: args.envelope.eventId,
        providerId: payload.providerId,
        windowCount: payload.windowCount,
        exceptionCount: payload.exceptionCount,
      },
      'provider.availability_updated.handle',
    );
    await this.orchestrator.project(payload.providerId);
  }
}
