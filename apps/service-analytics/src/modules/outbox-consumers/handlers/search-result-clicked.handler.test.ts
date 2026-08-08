import { SEARCH_RESULT_CLICKED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { PersistResult, RawEventsService } from '../../raw-events/raw-events.service';
import { SearchResultClickedHandler } from './search-result-clicked.handler';

const OCCURRED_AT = new Date('2026-06-09T12:00:00.000Z');

function makeArgs(): HandleArgs<typeof SEARCH_RESULT_CLICKED> {
  return {
    envelope: {
      eventId: 'clk_evt_1',
      eventName: SEARCH_RESULT_CLICKED,
      occurredAt: OCCURRED_AT,
      producerService: 'service-search',
      producerSchema: 'search',
    },
    payload: {
      eventId: 'clk_evt_1',
      occurredAt: OCCURRED_AT.toISOString(),
      searchId: 'srch_evt_1',
      actorUserId: 'user_123',
      providerId: 'prov_1',
      position: 2,
    },
  };
}

function makeRawEvents(impl: () => Promise<PersistResult>): RawEventsService {
  return {
    persistSearchResultClicked: vi.fn(impl),
    persistSearchPerformed: vi.fn(),
    persistBookingCreated: vi.fn(),
  } as unknown as RawEventsService;
}

describe('SearchResultClickedHandler', () => {
  it('forwards the envelope + payload to RawEventsService.persistSearchResultClicked', async () => {
    const rawEvents = makeRawEvents(async () => ({ persisted: true }));
    const handler = new SearchResultClickedHandler(rawEvents);
    const args = makeArgs();

    await handler.handle(args);

    expect(rawEvents.persistSearchResultClicked).toHaveBeenCalledTimes(1);
    expect(rawEvents.persistSearchResultClicked).toHaveBeenCalledWith(args.envelope, args.payload);
  });

  it('resolves without throwing on a redelivery (persisted=false)', async () => {
    const rawEvents = makeRawEvents(async () => ({ persisted: false }));
    const handler = new SearchResultClickedHandler(rawEvents);

    await expect(handler.handle(makeArgs())).resolves.toBeUndefined();
  });

  it('propagates a persistence failure so the SDK retries (no silent swallow)', async () => {
    const rawEvents = makeRawEvents(async () => {
      throw new Error('postgres-down');
    });
    const handler = new SearchResultClickedHandler(rawEvents);

    await expect(handler.handle(makeArgs())).rejects.toThrow('postgres-down');
  });
});
