import { Injectable, Logger } from '@nestjs/common';
import { SEARCH_PERFORMED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';

import { RawEventsService } from '../../raw-events/raw-events.service';

/**
 * Handler for `search.performed` events landed via the outbox relay
 * (TS-217-prep-3a; PDD §23.1; CLAUDE.md §5.3).
 *
 * Persists the raw event into `analytics.search_events` so the TS-217-prep-3b
 * nightly aggregation can compute the search-relevance marts (top queries,
 * zero-result rate, searches-per-sort). The handler is thin: it delegates the
 * persistence + idempotency to `RawEventsService` and logs the outcome.
 *
 * **Idempotency.** Idempotent on `envelope.eventId`:
 *   1. SDK dedup table — `analytics.outbox_consumer_dedup` PK on
 *      `(consumer_group, event_id)`; a re-delivered event whose row is already
 *      `processed` short-circuits at the SDK before this code runs.
 *   2. Persistence layer — `analytics.search_events.event_id` PK; the
 *      `createMany({ skipDuplicates: true })` in `RawEventsService` no-ops a
 *      redelivery (`persisted: false`) without throwing. The handler maps the
 *      relay-side `envelope.eventId` 1:1 into the table PK so both layers share
 *      the same key.
 *
 * **Failure handling.** Any persistence failure throws so the SDK records the
 * attempt + leaves the entry in the PEL for redelivery (no silent swallow —
 * CLAUDE.md §3.9). Persisting a raw analytics event is a plain INSERT with no
 * money math + no cross-service join (CLAUDE.md §2.3), so a failure here is a
 * transient DB blip the retry/dead-letter machinery rides out.
 */
@Injectable()
export class SearchPerformedHandler {
  private readonly logger = new Logger(SearchPerformedHandler.name);

  constructor(private readonly rawEvents: RawEventsService) {}

  async handle(args: HandleArgs<typeof SEARCH_PERFORMED>): Promise<void> {
    const { envelope, payload } = args;

    const { persisted } = await this.rawEvents.persistSearchPerformed(envelope, payload);

    this.logger.log(
      {
        eventId: envelope.eventId,
        actorUserId: payload.actorUserId,
        zeroResults: payload.zeroResults,
        resultCount: payload.resultCount,
        sort: payload.sort,
        persisted,
      },
      persisted ? 'outbox.search-performed.persisted' : 'outbox.search-performed.replayed',
    );
  }
}
