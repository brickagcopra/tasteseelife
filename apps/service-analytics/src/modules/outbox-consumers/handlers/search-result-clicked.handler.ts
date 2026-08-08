import { Injectable, Logger } from '@nestjs/common';
import { SEARCH_RESULT_CLICKED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { RawEventsService } from '../../raw-events/raw-events.service';

/**
 * Handler for `search.result_clicked` events landed via the outbox relay
 * (TS-217-prep-4b; PDD §23.1; CLAUDE.md §5.3).
 *
 * Persists the raw click into `analytics.search_click_events` so the
 * CTR-by-position aggregation mart (TS-217-prep-4b-followup-1) can compute
 * click-through-rate per result position, joining back to `search_events` on
 * the `search_id` correlation token (TS-217-prep-4a). The handler is thin: it
 * delegates persistence + idempotency to `RawEventsService` and logs the
 * outcome. Mirrors `SearchPerformedHandler` one-for-one.
 *
 * **Idempotency.** Idempotent on `envelope.eventId` at two layers — the SDK
 * dedup table (`analytics.outbox_consumer_dedup`) and the
 * `analytics.search_click_events.event_id` PK (the
 * `createMany({ skipDuplicates: true })` in `RawEventsService` no-ops a
 * redelivery).
 *
 * **Failure handling.** Any persistence failure throws so the SDK records the
 * attempt + leaves the entry in the PEL for redelivery (no silent swallow —
 * CLAUDE.md §3.9). Persisting a raw click is a plain INSERT with no money math +
 * no cross-service join (CLAUDE.md §2.3).
 */
@Injectable()
export class SearchResultClickedHandler {
  private readonly logger = new Logger(SearchResultClickedHandler.name);

  constructor(private readonly rawEvents: RawEventsService) {}

  async handle(args: HandleArgs<typeof SEARCH_RESULT_CLICKED>): Promise<void> {
    const { envelope, payload } = args;

    const { persisted } = await this.rawEvents.persistSearchResultClicked(envelope, payload);

    this.logger.log(
      {
        eventId: envelope.eventId,
        searchId: payload.searchId,
        providerId: payload.providerId,
        position: payload.position,
        persisted,
      },
      persisted
        ? 'outbox.search-result-clicked.persisted'
        : 'outbox.search-result-clicked.replayed',
    );
  }
}
