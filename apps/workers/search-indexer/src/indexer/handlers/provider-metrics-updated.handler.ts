import { Injectable, Logger } from '@nestjs/common';
import type { ProviderMetricsUpdated } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';

/**
 * Consumer handler for `provider.metrics_updated` (TS-053-followup-4a).
 *
 * The discovery document's `completedBookingCount` reads
 * service-provider's `provider_metrics` rollup (TS-053-followup-4), and
 * until this handler existed nothing told the indexer to look again when
 * a visit completed. The five provider-side events the indexer already
 * subscribes to are all *edits* — profile, certification, tier,
 * availability, coverage — so a provider's indexed count went stale
 * until their next edit, which is worst for exactly the providers the
 * field is meant to reward: the busy ones, who are not editing anything.
 *
 * The mechanical twin of `ProviderServiceAreasUpdatedHandler`, and thin
 * for the same reason: the only field it reads is `providerId`. The
 * payload's `completedBookingCount` is a snapshot at emission and is
 * **deliberately not used for the projection** — the orchestrator
 * re-fetches the source-of-truth snapshot, so a stale or reordered event
 * still produces a fresh document. It is logged, because when somebody
 * is diagnosing a search result that disagrees with a dossier, the count
 * the producer believed at emission time is the first thing they want.
 *
 * Returns `void` on success and throws on transport-layer failures; the
 * consumer SDK catches throws and retries on the next delivery cycle.
 * `invalid_provider_id` is absorbed by the orchestrator (terminal, no
 * retry) so the SDK XACKs a malformed event.
 */
@Injectable()
export class ProviderMetricsUpdatedHandler {
  private readonly logger = new Logger(ProviderMetricsUpdatedHandler.name);

  constructor(private readonly orchestrator: ProjectionOrchestratorService) {}

  async handle(args: HandleArgs<'provider.metrics_updated'>): Promise<void> {
    const payload = args.payload as ProviderMetricsUpdated;
    this.logger.debug(
      {
        eventId: args.envelope.eventId,
        providerId: payload.providerId,
        completedBookingCount: payload.completedBookingCount,
      },
      'provider.metrics_updated.handle',
    );
    await this.orchestrator.project(payload.providerId);
  }
}
