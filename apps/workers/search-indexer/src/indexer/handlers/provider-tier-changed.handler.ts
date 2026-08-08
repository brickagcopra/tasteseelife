import { Injectable, Logger } from '@nestjs/common';
import type { ProviderTierChanged } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { ProjectionOrchestratorService } from '../services/projection-orchestrator.service';

/**
 * Consumer handler for `provider.tier_changed` (TS-053).
 *
 * Delegates the entire projection to
 * `ProjectionOrchestratorService.project(providerId)` — the only
 * field this handler reads from the payload is `providerId`. Every
 * other field (the actual tier transition) is derived from the
 * source-of-truth snapshot the orchestrator fetches, so a stale
 * event still produces a fresh projection.
 *
 * The handler returns `void` on success and throws on transport-
 * layer failures. The consumer SDK catches throws, records the
 * failure in the dedup store, and retries on the next delivery
 * cycle. `invalid_provider_id` is treated as terminal (no retry —
 * the event is malformed and won't fix itself); the handler
 * absorbs the outcome and returns normally so the SDK XACKs.
 */
@Injectable()
export class ProviderTierChangedHandler {
  private readonly logger = new Logger(ProviderTierChangedHandler.name);

  constructor(private readonly orchestrator: ProjectionOrchestratorService) {}

  async handle(args: HandleArgs<'provider.tier_changed'>): Promise<void> {
    const payload = args.payload as ProviderTierChanged;
    this.logger.debug(
      {
        eventId: args.envelope.eventId,
        providerId: payload.providerId,
        fromTier: payload.fromTier,
        toTier: payload.toTier,
        reason: payload.reason,
      },
      'provider.tier_changed.handle',
    );
    await this.orchestrator.project(payload.providerId);
  }
}
