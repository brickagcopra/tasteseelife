import type {
  BookingServiceKind,
  BookingTierGatingViolationReason,
  CreateConciergeBookingRequest,
  ServiceCatalogRecord,
} from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { err, ok } from '../../../common/result';
import type {
  BookingRecord,
  BookingsService,
  BookingsServiceFailure,
} from '../../bookings/services/bookings.service';
import type { CatalogService } from '../../catalog/services/catalog.service';
import { ConciergeRequestsService } from './concierge-requests.service';
import { getServiceKindDefault } from './service-kind-defaults';

class FakeBookings {
  createBooking = vi.fn();
}

class FakeCatalog {
  getByKind = vi.fn();
}

/**
 * Build a catalog row whose band floor + currency mirror the
 * `service-kind-defaults.ts` constant for `kind` (the seed anchors the
 * floor on that constant, so this is the realistic seeded shape). Pass
 * `overrides` to prove the service reads a *different* catalog value
 * rather than the constant.
 */
function makeCatalogRecord(
  kind: BookingServiceKind,
  overrides: Partial<ServiceCatalogRecord> = {},
): ServiceCatalogRecord {
  const def = getServiceKindDefault(kind);
  return {
    kind,
    name: def.label,
    description: def.description,
    baseRateMinMinor: def.basePriceMinor,
    baseRateMaxMinor: def.basePriceMinor * 2,
    durationMinutes: 120,
    currency: def.currency,
    active: true,
    requiredProviderTier: null,
    sortPosition: 0,
    updatedAt: '2026-05-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeService(): {
  service: ConciergeRequestsService;
  bookings: FakeBookings;
  catalog: FakeCatalog;
} {
  const bookings = new FakeBookings();
  const catalog = new FakeCatalog();
  // Default: the catalog is seeded — return a row matching the constant.
  catalog.getByKind.mockImplementation(async (kind: BookingServiceKind) => makeCatalogRecord(kind));
  const service = new ConciergeRequestsService(
    bookings as unknown as BookingsService,
    catalog as unknown as CatalogService,
  );
  return { service, bookings, catalog };
}

const validRequest: CreateConciergeBookingRequest = {
  householdId: 'hh_abc',
  seniorId: 'snr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining',
  scheduledStart: '2026-06-10T17:00:00.000Z',
  scheduledEnd: '2026-06-10T19:00:00.000Z',
  bookingNotes: 'mom prefers a quiet meal',
};

const makeRecord = (): BookingRecord => ({
  id: 'bkg_fake_1',
  householdId: validRequest.householdId,
  seniorId: validRequest.seniorId,
  providerId: validRequest.providerId,
  serviceKind: validRequest.serviceKind,
  status: 'pending',
  scheduledStart: new Date(validRequest.scheduledStart),
  scheduledEnd: new Date(validRequest.scheduledEnd),
  currency: 'USD',
  basePrice: { toString: () => '150.00' },
  commissionRate: { toString: () => '0.2000' },
  commissionAmount: { toString: () => '30.00' },
  finalPrice: { toString: () => '150.00' },
  bookingNotes: validRequest.bookingNotes ?? null,
  completedAt: null,
  canceledAt: null,
  cancellationReason: null,
  cancellationReasonText: null,
  acceptWindowExpiresAt: new Date('2026-05-13T12:30:00.000Z'),
  declinedAt: null,
  declineKind: null,
  declineReason: null,
  declineReasonText: null,
  declinedByUserId: null,
  heldByIncidentId: null,
  createdAt: new Date('2026-05-13T12:00:00.000Z'),
  updatedAt: new Date('2026-05-13T12:00:00.000Z'),
});

describe('ConciergeRequestsService', () => {
  let service: ConciergeRequestsService;
  let bookings: FakeBookings;
  let catalog: FakeCatalog;

  beforeEach(() => {
    ({ service, bookings, catalog } = makeService());
  });

  it('passes the platform-default price + commission + currency to BookingsService', async () => {
    const defaults = getServiceKindDefault('companion_dining');
    bookings.createBooking.mockResolvedValueOnce(ok(makeRecord()));

    const result = await service.createRequest({
      actorUserId: 'usr_actor',
      request: validRequest,
    });

    expect(result.ok).toBe(true);
    expect(bookings.createBooking).toHaveBeenCalledTimes(1);
    const passed = bookings.createBooking.mock.calls[0]![0] as {
      actorUserId: string;
      request: Record<string, unknown>;
    };
    expect(passed.actorUserId).toBe('usr_actor');
    expect(passed.request['basePriceMinor']).toBe(defaults.basePriceMinor);
    expect(passed.request['commissionRateBps']).toBe(defaults.commissionRateBps);
    expect(passed.request['currency']).toBe(defaults.currency);
    expect(passed.request['serviceKind']).toBe(validRequest.serviceKind);
    expect(passed.request['householdId']).toBe(validRequest.householdId);
    expect(passed.request['seniorId']).toBe(validRequest.seniorId);
    expect(passed.request['providerId']).toBe(validRequest.providerId);
    expect(passed.request['scheduledStart']).toBe(validRequest.scheduledStart);
    expect(passed.request['scheduledEnd']).toBe(validRequest.scheduledEnd);
    expect(passed.request['bookingNotes']).toBe(validRequest.bookingNotes);
  });

  it('omits bookingNotes when the caller did not supply it', async () => {
    bookings.createBooking.mockResolvedValueOnce(ok(makeRecord()));
    const { bookingNotes: _, ...rest } = validRequest;

    await service.createRequest({ actorUserId: 'usr_actor', request: rest });

    const passed = bookings.createBooking.mock.calls[0]![0] as {
      request: Record<string, unknown>;
    };
    expect('bookingNotes' in passed.request).toBe(false);
  });

  it('forwards a searchId onto the create call (TS-217-prep-4c)', async () => {
    bookings.createBooking.mockResolvedValueOnce(ok(makeRecord()));

    await service.createRequest({
      actorUserId: 'usr_actor',
      request: { ...validRequest, searchId: 'srch_abc123' },
    });

    const passed = bookings.createBooking.mock.calls[0]![0] as {
      request: Record<string, unknown>;
    };
    expect(passed.request['searchId']).toBe('srch_abc123');
  });

  it('omits searchId when the caller did not supply it (TS-217-prep-4c)', async () => {
    bookings.createBooking.mockResolvedValueOnce(ok(makeRecord()));

    await service.createRequest({ actorUserId: 'usr_actor', request: validRequest });

    const passed = bookings.createBooking.mock.calls[0]![0] as {
      request: Record<string, unknown>;
    };
    expect('searchId' in passed.request).toBe(false);
  });

  it('looks up the right defaults for each service kind', async () => {
    const kindsToTest: Array<CreateConciergeBookingRequest['serviceKind']> = [
      'personal_chef_visit',
      'grocery_coordination',
      'event_dining',
    ];
    for (const kind of kindsToTest) {
      bookings.createBooking.mockResolvedValueOnce(ok({ ...makeRecord(), serviceKind: kind }));
      const defaults = getServiceKindDefault(kind);
      await service.createRequest({
        actorUserId: 'usr_actor',
        request: { ...validRequest, serviceKind: kind },
      });
      const passed = bookings.createBooking.mock.calls.at(-1)![0] as {
        request: Record<string, unknown>;
      };
      expect(passed.request['basePriceMinor']).toBe(defaults.basePriceMinor);
      expect(passed.request['serviceKind']).toBe(kind);
    }
  });

  it('forwards a tier-gating failure unchanged', async () => {
    const reason: BookingTierGatingViolationReason = 'tier_3_requires_elite';
    const failure: BookingsServiceFailure = {
      reason: 'tier_gating_violation',
      violationReason: reason,
      householdTier: 'tier_3_concierge',
      providerTier: 'certified',
    };
    bookings.createBooking.mockResolvedValueOnce(err(failure));

    const result = await service.createRequest({
      actorUserId: 'usr_actor',
      request: validRequest,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(failure);
    }
  });

  it('forwards an outbox_validation_failed failure unchanged', async () => {
    const failure: BookingsServiceFailure = {
      reason: 'outbox_validation_failed',
      message: 'event booking.created payload failed validation',
    };
    bookings.createBooking.mockResolvedValueOnce(err(failure));

    const result = await service.createRequest({
      actorUserId: 'usr_actor',
      request: validRequest,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('outbox_validation_failed');
  });

  it('returns the BookingRecord from a successful create', async () => {
    const record = makeRecord();
    bookings.createBooking.mockResolvedValueOnce(ok(record));

    const result = await service.createRequest({
      actorUserId: 'usr_actor',
      request: validRequest,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(record);
    }
  });

  it('derives basePrice + currency from the catalog band floor, not the constant', async () => {
    // Catalog floor deliberately diverges from the constant so a passing
    // assertion proves the service read the catalog, not the default.
    catalog.getByKind.mockResolvedValueOnce(
      makeCatalogRecord('companion_dining', { baseRateMinMinor: 9_900 }),
    );
    bookings.createBooking.mockResolvedValueOnce(ok(makeRecord()));

    await service.createRequest({ actorUserId: 'usr_actor', request: validRequest });

    expect(catalog.getByKind).toHaveBeenCalledWith('companion_dining');
    const passed = bookings.createBooking.mock.calls[0]![0] as {
      request: Record<string, unknown>;
    };
    const defaults = getServiceKindDefault('companion_dining');
    expect(passed.request['basePriceMinor']).toBe(9_900);
    expect(passed.request['basePriceMinor']).not.toBe(defaults.basePriceMinor);
    expect(passed.request['currency']).toBe('USD');
  });

  it('falls back to the service-kind-defaults constant when the catalog has no row', async () => {
    catalog.getByKind.mockResolvedValueOnce(null);
    bookings.createBooking.mockResolvedValueOnce(ok(makeRecord()));
    const defaults = getServiceKindDefault('companion_dining');

    await service.createRequest({ actorUserId: 'usr_actor', request: validRequest });

    const passed = bookings.createBooking.mock.calls[0]![0] as {
      request: Record<string, unknown>;
    };
    expect(passed.request['basePriceMinor']).toBe(defaults.basePriceMinor);
    expect(passed.request['currency']).toBe(defaults.currency);
  });

  it('always sources commissionRateBps from the constant, even with a catalog row present', async () => {
    catalog.getByKind.mockResolvedValueOnce(
      makeCatalogRecord('companion_dining', { baseRateMinMinor: 9_900 }),
    );
    bookings.createBooking.mockResolvedValueOnce(ok(makeRecord()));
    const defaults = getServiceKindDefault('companion_dining');

    await service.createRequest({ actorUserId: 'usr_actor', request: validRequest });

    const passed = bookings.createBooking.mock.calls[0]![0] as {
      request: Record<string, unknown>;
    };
    expect(passed.request['commissionRateBps']).toBe(defaults.commissionRateBps);
  });
});
