import { describe, expect, it } from 'vitest';

import type { BookingRecord } from '../services/bookings.service';
import { toBookingResponse } from './booking.mapper';

function baseRow(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'bkg_abc',
    householdId: 'hh_abc',
    seniorId: 'sr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining',
    status: 'pending',
    scheduledStart: new Date('2026-05-20T18:00:00.000Z'),
    scheduledEnd: new Date('2026-05-20T20:00:00.000Z'),
    currency: 'USD',
    basePrice: { toString: () => '150.00' },
    commissionRate: { toString: () => '0.3000' },
    commissionAmount: { toString: () => '45.00' },
    finalPrice: { toString: () => '150.00' },
    bookingNotes: null,
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
    ...overrides,
  };
}

describe('toBookingResponse', () => {
  it('converts a row to the BookingResponse shape', () => {
    const dto = toBookingResponse(baseRow());

    expect(dto.id).toBe('bkg_abc');
    expect(dto.status).toBe('pending');
    expect(dto.serviceKind).toBe('companion_dining');
    expect(dto.basePriceMinor).toBe(15_000);
    expect(dto.commissionRateBps).toBe(3000);
    expect(dto.commissionAmountMinor).toBe(4_500);
    expect(dto.finalPriceMinor).toBe(15_000);
  });

  it('serializes Date fields as ISO strings', () => {
    const dto = toBookingResponse(baseRow());
    expect(dto.scheduledStart).toBe('2026-05-20T18:00:00.000Z');
    expect(dto.scheduledEnd).toBe('2026-05-20T20:00:00.000Z');
    expect(dto.createdAt).toBe('2026-05-13T12:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-05-13T12:00:00.000Z');
  });

  it('serializes nullable timestamps as null when null', () => {
    const dto = toBookingResponse(baseRow());
    expect(dto.completedAt).toBeNull();
    expect(dto.canceledAt).toBeNull();
  });

  it('serializes nullable timestamps as ISO when present', () => {
    const dto = toBookingResponse(
      baseRow({
        status: 'completed',
        completedAt: new Date('2026-05-20T20:30:00.000Z'),
      }),
    );
    expect(dto.completedAt).toBe('2026-05-20T20:30:00.000Z');
  });

  it('narrows cancellationReason to null on unknown values (defensive)', () => {
    const dto = toBookingResponse(
      baseRow({
        status: 'canceled',
        canceledAt: new Date('2026-05-19T15:00:00.000Z'),
        cancellationReason: 'some_garbage',
        cancellationReasonText: 'who knows',
      }),
    );
    expect(dto.cancellationReason).toBeNull();
    // Free-form text is opaque; the mapper just passes it through.
    expect(dto.cancellationReasonText).toBe('who knows');
  });

  it('passes through known cancellation reasons', () => {
    const dto = toBookingResponse(
      baseRow({
        status: 'canceled',
        canceledAt: new Date('2026-05-19T15:00:00.000Z'),
        cancellationReason: 'family_request',
        cancellationReasonText: 'family travel plans',
      }),
    );
    expect(dto.cancellationReason).toBe('family_request');
    expect(dto.cancellationReasonText).toBe('family travel plans');
  });

  it('handles negative decimal strings (e.g. credit / refund)', () => {
    const dto = toBookingResponse(
      baseRow({
        finalPrice: { toString: () => '-99.05' },
      }),
    );
    expect(dto.finalPriceMinor).toBe(-9905);
  });

  it('handles zero-cent amounts', () => {
    const dto = toBookingResponse(
      baseRow({
        basePrice: { toString: () => '0.00' },
        commissionAmount: { toString: () => '0.00' },
        finalPrice: { toString: () => '0.00' },
        commissionRate: { toString: () => '0.0000' },
      }),
    );
    expect(dto.basePriceMinor).toBe(0);
    expect(dto.commissionAmountMinor).toBe(0);
    expect(dto.finalPriceMinor).toBe(0);
    expect(dto.commissionRateBps).toBe(0);
  });

  it('handles the maximum-rate (10000 bps)', () => {
    const dto = toBookingResponse(
      baseRow({
        commissionRate: { toString: () => '1.0000' },
      }),
    );
    expect(dto.commissionRateBps).toBe(10_000);
  });

  it('serializes the TS-205 accept window stamp as ISO when present', () => {
    const dto = toBookingResponse(baseRow());
    expect(dto.acceptWindowExpiresAt).toBe('2026-05-13T12:30:00.000Z');
  });

  it('serializes a null accept window stamp as null (back-fill rows)', () => {
    const dto = toBookingResponse(baseRow({ acceptWindowExpiresAt: null }));
    expect(dto.acceptWindowExpiresAt).toBeNull();
  });

  it('passes through known decline kind + reason on a declined row', () => {
    const dto = toBookingResponse(
      baseRow({
        status: 'declined',
        declinedAt: new Date('2026-05-13T12:15:00.000Z'),
        declineKind: 'provider_declined',
        declineReason: 'schedule_conflict',
        declineReasonText: 'double-booked',
        declinedByUserId: 'usr_provider',
      }),
    );
    expect(dto.status).toBe('declined');
    expect(dto.declinedAt).toBe('2026-05-13T12:15:00.000Z');
    expect(dto.declineKind).toBe('provider_declined');
    expect(dto.declineReason).toBe('schedule_conflict');
    expect(dto.declineReasonText).toBe('double-booped'.replace('-boop', '-book'));
    expect(dto.declinedByUserId).toBe('usr_provider');
  });

  it('narrows unknown decline kind / reason to null (defensive)', () => {
    const dto = toBookingResponse(
      baseRow({
        status: 'declined',
        declinedAt: new Date('2026-05-13T12:15:00.000Z'),
        declineKind: 'some_garbage',
        declineReason: 'also_garbage',
        declinedByUserId: 'usr_provider',
      }),
    );
    expect(dto.declineKind).toBeNull();
    expect(dto.declineReason).toBeNull();
    expect(dto.declinedByUserId).toBe('usr_provider');
  });

  it('window_expired auto-decline produces null reason without losing kind', () => {
    const dto = toBookingResponse(
      baseRow({
        status: 'declined',
        declinedAt: new Date('2026-05-13T12:30:00.000Z'),
        declineKind: 'window_expired',
        declineReason: null,
        declinedByUserId: 'sys:booking-window-watcher',
      }),
    );
    expect(dto.declineKind).toBe('window_expired');
    expect(dto.declineReason).toBeNull();
    expect(dto.declinedByUserId).toBe('sys:booking-window-watcher');
  });
});

describe('toBookingResponse — trust & safety hold (TS-304-followup-1)', () => {
  it('reports a held booking as onHold', () => {
    // TS-304 made the hold ENFORCED and INVISIBLE: the visit was blocked and
    // every read surface rendered it as proceeding normally.
    const dto = toBookingResponse(baseRow({ heldByIncidentId: 'inc_abc' }));
    expect(dto.onHold).toBe(true);
  });

  it('reports an unheld booking as not onHold', () => {
    expect(toBookingResponse(baseRow()).onHold).toBe(false);
  });

  it('NEVER lets the incident id reach the DTO', () => {
    // This mapper line is the disclosure boundary. `BookingResponse` is served
    // to the family portal, and a hold means somebody — possibly the reader —
    // is under review for a high or critical concern. The ops view lives
    // behind `trust_safety:read` at GET /api/v1/admin/booking-holds.
    const dto = toBookingResponse(baseRow({ heldByIncidentId: 'inc_abc' }));
    expect(JSON.stringify(dto)).not.toContain('inc_abc');
    expect(Object.keys(dto)).not.toContain('heldByIncidentId');
  });

  it('keeps the flag true on a completed or cancelled booking', () => {
    // The flag tracks the column rather than second-guessing it: a hold that
    // outlives the visit is still a hold, and inferring otherwise here would
    // put a second copy of the release rule in the mapper.
    for (const status of ['completed', 'canceled'] as const) {
      expect(toBookingResponse(baseRow({ status, heldByIncidentId: 'inc_abc' })).onHold).toBe(true);
    }
  });
});
