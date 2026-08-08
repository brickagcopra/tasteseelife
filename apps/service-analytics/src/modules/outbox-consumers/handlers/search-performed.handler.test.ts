import { SEARCH_PERFORMED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { PersistResult, RawEventsService } from '../../raw-events/raw-events.service';
import { SearchPerformedHandler } from './search-performed.handler';

const OCCURRED_AT = new Date('2026-06-09T12:00:00.000Z');

function makeArgs(): HandleArgs<typeof SEARCH_PERFORMED> {
  return {
    envelope: {
      eventId: 'srch_evt_1',
      eventName: SEARCH_PERFORMED,
      occurredAt: OCCURRED_AT,
      producerService: 'service-search',
      producerSchema: 'search',
    },
    payload: {
      eventId: 'srch_evt_1',
      occurredAt: OCCURRED_AT.toISOString(),
      actorUserId: 'user_123',
      queryText: 'memory care chef',
      sort: 'relevance',
      hasGeo: false,
      appliedFilters: ['specialties'],
      filterTiers: [],
      resultCount: 0,
      totalEstimate: 0,
      zeroResults: true,
      page: 'first',
      liveMode: false,
    },
  };
}

function makeRawEvents(impl: () => Promise<PersistResult>): RawEventsService {
  return {
    persistSearchPerformed: vi.fn(impl),
    persistBookingCreated: vi.fn(),
  } as unknown as RawEventsService;
}

describe('SearchPerformedHandler', () => {
  it('forwards the envelope + payload to RawEventsService.persistSearchPerformed', async () => {
    const rawEvents = makeRawEvents(async () => ({ persisted: true }));
    const handler = new SearchPerformedHandler(rawEvents);
    const args = makeArgs();

    await handler.handle(args);

    expect(rawEvents.persistSearchPerformed).toHaveBeenCalledTimes(1);
    expect(rawEvents.persistSearchPerformed).toHaveBeenCalledWith(args.envelope, args.payload);
  });

  it('resolves without throwing on a redelivery (persisted=false)', async () => {
    const rawEvents = makeRawEvents(async () => ({ persisted: false }));
    const handler = new SearchPerformedHandler(rawEvents);

    await expect(handler.handle(makeArgs())).resolves.toBeUndefined();
  });

  it('propagates a persistence failure so the SDK retries (no silent swallow)', async () => {
    const rawEvents = makeRawEvents(async () => {
      throw new Error('postgres-down');
    });
    const handler = new SearchPerformedHandler(rawEvents);

    await expect(handler.handle(makeArgs())).rejects.toThrow('postgres-down');
  });
});
