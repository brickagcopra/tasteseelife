import { Injectable, Logger } from '@nestjs/common';
import type { ProviderProfileUpdated } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';

/**
 * Consumer handler for `provider.profile_updated` (TS-053-followup-5).
 *
 * A self-service profile edit (PUT on the provider profile — display
 * name / headline / bio / the three tag sets / the dementia-sensitive
 * flag) changes fields the discovery doc surfaces, so the search doc
 * must re-project for the family-portal search to reflect the new
 * state within one relay cycle. Without this subscription a profile
 * edit silently drifts the index.
 *
 * Like the sibling provider-event handlers, this is a thin shell: the
 * only field it reads from the payload is `providerId`. The actual
 * edited fields are derived from the source-of-truth snapshot the
 * orchestrator fetches, so a stale event still produces a fresh
 * projection. The `changedKinds` field on the event is intentionally
 * ignored here — the indexer always re-projects regardless of which
 * kinds touched, because every profile field the event covers feeds
 * the discovery doc (the per-kind skip is a notification-svc
 * optimisation, not a search-indexer one).
 *
 * Returns `void` on success and throws on transport-layer failures; the
 * consumer SDK catches throws and retries on the next delivery cycle.
 * `invalid_provider_id` is absorbed by the orchestrator (terminal, no
 * retry) so the SDK XACKs a malformed event.
 */
@Injectable()
export class ProviderProfileUpdatedHandler {
  private readonly logger = new Logger(ProviderProfileUpdatedHandler.name);

  constructor(private readonly orchestrator: ProjectionOrchestratorService) {}

  async handle(args: HandleArgs<'provider.profile_updated'>): Promise<void> {
    const payload = args.payload as ProviderProfileUpdated;
    this.logger.debug(
      {
        eventId: args.envelope.eventId,
        providerId: payload.providerId,
        changedKinds: payload.changedKinds,
      },
      'provider.profile_updated.handle',
    );
    await this.orchestrator.project(payload.providerId);
  }
}
