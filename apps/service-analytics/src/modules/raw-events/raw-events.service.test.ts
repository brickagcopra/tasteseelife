import { SEARCH_PERFORMED, SEARCH_RESULT_CLICKED, BOOKING_CREATED } from '@taste-and-see/contracts';
import type {
  BookingCreated,
  SearchPerformed,
  SearchResultClicked,
} from '@taste-and-see/contracts';
import type { ConsumerEventEnvelope } from '@taste-and-see/nest-outbox-consumer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../prisma/prisma.service';
import { RawEventsService } from './raw-events.service';

/**
 * Unit tests for `RawEventsService` against a fake Prisma client.
 *
 * The service does idempotent `createMany({ skipDuplicates: true })` inserts;
 * the fake returns a configurable `{ count }` so we can assert the
 * `persisted` outcome reflects the insert (`count > 0`) vs a redelivery
 * (`count === 0`) and that the envelope → row mapping is correct.
 */

const OCCURRED_AT = new Date('2026-06-09T12:00:00.000Z');

function makeSearchEnvelope(eventId = 'srch_evt_1'): ConsumerEventEnvelope {
  return {
    eventId,
    eventName: SEARCH_PERFORMED,
    occurredAt: OCCURRED_AT,
    producerService: 'service-search',
    producerSchema: 'search',
  };
}

function makeBookingEnvelope(eventId = 'bkg_evt_1'): ConsumerEventEnvelope {
  return {
    eventId,
    eventName: BOOKING_CREATED,
    occurredAt: OCCURRED_AT,
    producerService: 'service-booking',
    producerSchema: 'booking',
  };
}

function makeSearchPayload(overrides: Partial<SearchPerformed> = {}): SearchPerformed {
  return {
    eventId: 'srch_evt_1',
    occurredAt: OCCURRED_AT.toISOString(),
    actorUserId: 'user_123',
    queryText: 'kosher chef upper east side',
    sort: 'relevance',
    hasGeo: true,
    appliedFilters: ['tiers', 'languages'],
    filterTiers: ['elite'],
    resultCount: 4,
    totalEstimate: 12,
    zeroResults: false,
    page: 'first',
    liveMode: false,
    ...overrides,
  };
}

function makeBookingPayload(overrides: Partial<BookingCreated> = {}): BookingCreated {
  return {
    eventId: 'bkg_evt_1',
    occurredAt: OCCURRED_AT.toISOString(),
    bookingId: 'bkg_1',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    providerId: 'prov_1',
    serviceKind: 'companion_dining',
    scheduledStart: '2026-06-10T17:00:00.000Z',
    scheduledEnd: '2026-06-10T19:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 15000,
    commissionRateBps: 2000,
    commissionAmountMinor: 3000,
    finalPriceMinor: 15000,
    ...overrides,
  };
}

function makeClickEnvelope(eventId = 'clk_evt_1'): ConsumerEventEnvelope {
  return {
    eventId,
    eventName: SEARCH_RESULT_CLICKED,
    occurredAt: OCCURRED_AT,
    producerService: 'service-search',
    producerSchema: 'search',
  };
}

function makeClickPayload(overrides: Partial<SearchResultClicked> = {}): SearchResultClicked {
  return {
    eventId: 'clk_evt_1',
    occurredAt: OCCURRED_AT.toISOString(),
    searchId: 'srch_evt_1',
    actorUserId: 'user_123',
    providerId: 'prov_1',
    position: 2,
    ...overrides,
  };
}

interface FakePrisma {
  searchEvent: { createMany: ReturnType<typeof vi.fn> };
  searchClickEvent: { createMany: ReturnType<typeof vi.fn> };
  bookingCreatedEvent: { createMany: ReturnType<typeof vi.fn> };
}

function makeService(count: number): { service: RawEventsService; prisma: FakePrisma } {
  const prisma: FakePrisma = {
    searchEvent: { createMany: vi.fn(async () => ({ count })) },
    searchClickEvent: { createMany: vi.fn(async () => ({ count })) },
    bookingCreatedEvent: { createMany: vi.fn(async () => ({ count })) },
  };
  const service = new RawEventsService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('RawEventsService.persistSearchPerformed', () => {
  let service: RawEventsService;
  let prisma: FakePrisma;

  beforeEach(() => {
    ({ service, prisma } = makeService(1));
  });

  it('maps the envelope + payload into the search_events row shape', async () => {
    await service.persistSearchPerformed(makeSearchEnvelope(), makeSearchPayload());

    expect(prisma.searchEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.searchEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          eventId: 'srch_evt_1',
          // the relay-parsed envelope timestamp is the time axis, NOT a
          // re-parse of payload.occurredAt
          occurredAt: OCCURRED_AT,
          actorUserId: 'user_123',
          queryText: 'kosher chef upper east side',
          sort: 'relevance',
          hasGeo: true,
          appliedFilters: ['tiers', 'languages'],
          filterTiers: ['elite'],
          resultCount: 4,
          totalEstimate: 12,
          zeroResults: false,
          page: 'first',
          liveMode: false,
          producerService: 'service-search',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('reports persisted=true when a row is inserted (count > 0)', async () => {
    const result = await service.persistSearchPerformed(makeSearchEnvelope(), makeSearchPayload());
    expect(result).toEqual({ persisted: true });
  });

  it('reports persisted=false on a redelivery (count === 0)', async () => {
    ({ service, prisma } = makeService(0));
    const result = await service.persistSearchPerformed(makeSearchEnvelope(), makeSearchPayload());
    expect(result).toEqual({ persisted: false });
  });

  it('persists a null queryText (no-text discovery browse) verbatim', async () => {
    await service.persistSearchPerformed(
      makeSearchEnvelope(),
      makeSearchPayload({ queryText: null, appliedFilters: [], filterTiers: [] }),
    );

    const arg = prisma.searchEvent.createMany.mock.calls[0]?.[0] as {
      data: Array<{ queryText: string | null; appliedFilters: string[] }>;
    };
    expect(arg.data[0]?.queryText).toBeNull();
    expect(arg.data[0]?.appliedFilters).toEqual([]);
  });
});

describe('RawEventsService.persistSearchResultClicked', () => {
  let service: RawEventsService;
  let prisma: FakePrisma;

  beforeEach(() => {
    ({ service, prisma } = makeService(1));
  });

  it('maps the envelope + payload into the search_click_events row shape', async () => {
    await service.persistSearchResultClicked(makeClickEnvelope(), makeClickPayload());

    expect(prisma.searchClickEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.searchClickEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          eventId: 'clk_evt_1',
          // the relay-parsed envelope timestamp is the time axis
          occurredAt: OCCURRED_AT,
          searchId: 'srch_evt_1',
          actorUserId: 'user_123',
          providerId: 'prov_1',
          position: 2,
          producerService: 'service-search',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('reports persisted=true on insert and false on redelivery', async () => {
    const inserted = await service.persistSearchResultClicked(
      makeClickEnvelope(),
      makeClickPayload(),
    );
    expect(inserted).toEqual({ persisted: true });

    ({ service } = makeService(0));
    const replayed = await service.persistSearchResultClicked(
      makeClickEnvelope(),
      makeClickPayload(),
    );
    expect(replayed).toEqual({ persisted: false });
  });
});

describe('RawEventsService.persistBookingCreated', () => {
  let service: RawEventsService;
  let prisma: FakePrisma;

  beforeEach(() => {
    ({ service, prisma } = makeService(1));
  });

  it('maps the envelope + payload into the booking_created_events row shape', async () => {
    await service.persistBookingCreated(makeBookingEnvelope(), makeBookingPayload());

    expect(prisma.bookingCreatedEvent.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.bookingCreatedEvent.createMany).toHaveBeenCalledWith({
      data: [
        {
          eventId: 'bkg_evt_1',
          occurredAt: OCCURRED_AT,
          bookingId: 'bkg_1',
          householdId: 'hh_1',
          searchId: null,
          seniorId: 'sen_1',
          providerId: 'prov_1',
          serviceKind: 'companion_dining',
          scheduledStart: new Date('2026-06-10T17:00:00.000Z'),
          scheduledEnd: new Date('2026-06-10T19:00:00.000Z'),
          currency: 'USD',
          basePriceMinor: 15000,
          commissionRateBps: 2000,
          commissionAmountMinor: 3000,
          finalPriceMinor: 15000,
          producerService: 'service-booking',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('maps a present searchId onto the row (TS-217-prep-4c precise conversion)', async () => {
    await service.persistBookingCreated(
      makeBookingEnvelope(),
      makeBookingPayload({ searchId: 'srch_evt_1' }),
    );

    const arg = prisma.bookingCreatedEvent.createMany.mock.calls[0]?.[0] as {
      data: ReadonlyArray<{ searchId: string | null }>;
    };
    expect(arg.data[0]?.searchId).toBe('srch_evt_1');
  });

  it('reports persisted=true on insert and false on redelivery', async () => {
    const inserted = await service.persistBookingCreated(
      makeBookingEnvelope(),
      makeBookingPayload(),
    );
    expect(inserted).toEqual({ persisted: true });

    ({ service } = makeService(0));
    const replayed = await service.persistBookingCreated(
      makeBookingEnvelope(),
      makeBookingPayload(),
    );
    expect(replayed).toEqual({ persisted: false });
  });
});
