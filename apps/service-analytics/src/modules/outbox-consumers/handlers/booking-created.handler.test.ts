import { BOOKING_CREATED } from '@taste-and-see/contracts';
import type { HandleArgs } from '@taste-and-see/nest-outbox-consumer';
import { describe, expect, it, vi } from 'vitest';

import type { PersistResult, RawEventsService } from '../../raw-events/raw-events.service';
import { BookingCreatedHandler } from './booking-created.handler';

const OCCURRED_AT = new Date('2026-06-09T12:00:00.000Z');

function makeArgs(): HandleArgs<typeof BOOKING_CREATED> {
  return {
    envelope: {
      eventId: 'bkg_evt_1',
      eventName: BOOKING_CREATED,
      occurredAt: OCCURRED_AT,
      producerService: 'service-booking',
      producerSchema: 'booking',
    },
    payload: {
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
    },
  };
}

function makeRawEvents(impl: () => Promise<PersistResult>): RawEventsService {
  return {
    persistSearchPerformed: vi.fn(),
    persistBookingCreated: vi.fn(impl),
  } as unknown as RawEventsService;
}

describe('BookingCreatedHandler', () => {
  it('forwards the envelope + payload to RawEventsService.persistBookingCreated', async () => {
    const rawEvents = makeRawEvents(async () => ({ persisted: true }));
    const handler = new BookingCreatedHandler(rawEvents);
    const args = makeArgs();

    await handler.handle(args);

    expect(rawEvents.persistBookingCreated).toHaveBeenCalledTimes(1);
    expect(rawEvents.persistBookingCreated).toHaveBeenCalledWith(args.envelope, args.payload);
  });

  it('resolves without throwing on a redelivery (persisted=false)', async () => {
    const rawEvents = makeRawEvents(async () => ({ persisted: false }));
    const handler = new BookingCreatedHandler(rawEvents);

    await expect(handler.handle(makeArgs())).resolves.toBeUndefined();
  });

  it('propagates a persistence failure so the SDK retries', async () => {
    const rawEvents = makeRawEvents(async () => {
      throw new Error('postgres-down');
    });
    const handler = new BookingCreatedHandler(rawEvents);

    await expect(handler.handle(makeArgs())).rejects.toThrow('postgres-down');
  });
});
