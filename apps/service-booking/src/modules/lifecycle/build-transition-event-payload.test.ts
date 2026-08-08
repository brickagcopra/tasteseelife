/**
 * Unit tests for the shared `buildTransitionEventPayload` helper.
 *
 * Coverage spans the four event branches plus the cancel-args
 * defences. The behaviour-equivalent pre-refactor switches lived
 * inline inside `BookingsService.transitionStatus` (4 events) and
 * `CheckInsService.record` (2 events) — those service-level tests
 * exercise the helper indirectly through the public surface; this
 * file exercises the helper in isolation so a regression localises
 * to one file.
 *
 * The `row` fixture here is the minimum-viable `BookingRecord`
 * shape — money fields are `Decimal`-string surrogates (objects
 * with `.toString()`) because the helper only ever calls
 * `.toString()` on them, matching the production type
 * (`{ toString(): string }`).
 */
import {
  BOOKING_CANCELED,
  BOOKING_COMPLETED,
  BOOKING_CONFIRMED,
  BOOKING_IN_PROGRESS,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import type { BookingRecord } from '../bookings/services/bookings.service';
import { buildTransitionEventPayload } from './build-transition-event-payload';

const NOW = new Date('2026-05-19T12:00:00.000Z');

function makeRow(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'bkg_01',
    householdId: 'hh_01',
    seniorId: 'sr_01',
    providerId: 'pr_01',
    serviceKind: 'companion_dining',
    status: 'in_progress',
    scheduledStart: new Date('2026-05-19T13:00:00.000Z'),
    scheduledEnd: new Date('2026-05-19T15:00:00.000Z'),
    currency: 'USD',
    basePrice: { toString: () => '120.00' },
    commissionRate: { toString: () => '0.3000' },
    commissionAmount: { toString: () => '45.00' },
    finalPrice: { toString: () => '150.00' },
    bookingNotes: null,
    completedAt: null,
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    acceptWindowExpiresAt: new Date('2026-05-18T12:30:00.000Z'),
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    heldByIncidentId: null,
    createdAt: new Date('2026-05-18T12:00:00.000Z'),
    updatedAt: NOW,
    ...overrides,
  };
}

describe('buildTransitionEventPayload', () => {
  describe('BOOKING_CONFIRMED', () => {
    it('emits the confirmed payload with envelope + identifiers + scheduling window + confirmedAt', () => {
      const row = makeRow({ status: 'confirmed' });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_CONFIRMED,
        row,
        now: NOW,
      }) as Record<string, unknown>;

      expect(payload['eventId']).toBe(`${row.id}.confirmed.${NOW.getTime()}`);
      expect(payload['occurredAt']).toBe(NOW.toISOString());
      expect(payload['bookingId']).toBe('bkg_01');
      expect(payload['householdId']).toBe('hh_01');
      expect(payload['seniorId']).toBe('sr_01');
      expect(payload['providerId']).toBe('pr_01');
      expect(payload['serviceKind']).toBe('companion_dining');
      expect(payload['scheduledStart']).toBe('2026-05-19T13:00:00.000Z');
      expect(payload['scheduledEnd']).toBe('2026-05-19T15:00:00.000Z');
      expect(payload['confirmedAt']).toBe(NOW.toISOString());
    });
  });

  describe('BOOKING_IN_PROGRESS', () => {
    it('emits the in-progress payload with startedAt = now', () => {
      const row = makeRow({ status: 'in_progress' });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_IN_PROGRESS,
        row,
        now: NOW,
      }) as Record<string, unknown>;

      expect(payload['eventId']).toBe(`${row.id}.in_progress.${NOW.getTime()}`);
      expect(payload['occurredAt']).toBe(NOW.toISOString());
      expect(payload['bookingId']).toBe('bkg_01');
      expect(payload['startedAt']).toBe(NOW.toISOString());
      // No money fields on the in_progress payload — guard against a
      // regression that mixed the BOOKING_COMPLETED money block into
      // this branch by accident.
      expect(payload['grossAmountMinor']).toBeUndefined();
      expect(payload['providerAmountMinor']).toBeUndefined();
      expect(payload['marketplaceAmountMinor']).toBeUndefined();
      expect(payload['commissionRateBps']).toBeUndefined();
    });
  });

  describe('BOOKING_COMPLETED', () => {
    it('emits the completed payload with the gross == provider + marketplace invariant', () => {
      const row = makeRow({ status: 'completed' });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_COMPLETED,
        row,
        now: NOW,
      }) as Record<string, unknown>;

      expect(payload['eventId']).toBe(`${row.id}.completed.${NOW.getTime()}`);
      expect(payload['completedAt']).toBe(NOW.toISOString());
      expect(payload['currency']).toBe('USD');
      // finalPrice $150.00 → 15000 minor units
      expect(payload['grossAmountMinor']).toBe(15_000);
      // commissionAmount $45.00 → 4500 minor units
      expect(payload['marketplaceAmountMinor']).toBe(4_500);
      // gross - marketplace = 10500
      expect(payload['providerAmountMinor']).toBe(10_500);
      // commissionRate 0.3000 → 3000 bps
      expect(payload['commissionRateBps']).toBe(3_000);
      // Invariant cross-check: a regression in the math would break
      // here even if the individual fields land valid in isolation.
      expect(
        (payload['providerAmountMinor'] as number) + (payload['marketplaceAmountMinor'] as number),
      ).toBe(payload['grossAmountMinor']);
    });

    it('handles the basic-tier 30% commission band correctly', () => {
      // $100.00 base × 30% = $30.00 commission; gross $100.00.
      const row = makeRow({
        status: 'completed',
        basePrice: { toString: () => '100.00' },
        commissionRate: { toString: () => '0.3000' },
        commissionAmount: { toString: () => '30.00' },
        finalPrice: { toString: () => '100.00' },
      });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_COMPLETED,
        row,
        now: NOW,
      }) as Record<string, unknown>;

      expect(payload['grossAmountMinor']).toBe(10_000);
      expect(payload['marketplaceAmountMinor']).toBe(3_000);
      expect(payload['providerAmountMinor']).toBe(7_000);
      expect(payload['commissionRateBps']).toBe(3_000);
    });

    it('handles the elite-tier 10% commission band correctly', () => {
      const row = makeRow({
        status: 'completed',
        basePrice: { toString: () => '200.00' },
        commissionRate: { toString: () => '0.1000' },
        commissionAmount: { toString: () => '20.00' },
        finalPrice: { toString: () => '200.00' },
      });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_COMPLETED,
        row,
        now: NOW,
      }) as Record<string, unknown>;

      expect(payload['grossAmountMinor']).toBe(20_000);
      expect(payload['marketplaceAmountMinor']).toBe(2_000);
      expect(payload['providerAmountMinor']).toBe(18_000);
      expect(payload['commissionRateBps']).toBe(1_000);
    });
  });

  describe('BOOKING_CANCELED', () => {
    it('emits the canceled payload with previousStatus, canceledByUserId, and the supplied cancellationReason', () => {
      const row = makeRow({ status: 'canceled', canceledAt: NOW });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_CANCELED,
        row,
        now: NOW,
        previousStatus: 'confirmed',
        actorUserId: 'usr_payer_01',
        cancellationReason: 'family_request',
      }) as Record<string, unknown>;

      expect(payload['eventId']).toBe(`${row.id}.canceled.${NOW.getTime()}`);
      expect(payload['canceledAt']).toBe(NOW.toISOString());
      expect(payload['previousStatus']).toBe('confirmed');
      expect(payload['cancellationReason']).toBe('family_request');
      expect(payload['canceledByUserId']).toBe('usr_payer_01');
    });

    it("defaults cancellationReason to 'other' when omitted", () => {
      const row = makeRow({ status: 'canceled', canceledAt: NOW });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_CANCELED,
        row,
        now: NOW,
        previousStatus: 'pending',
        actorUserId: 'usr_provider_01',
      }) as Record<string, unknown>;

      expect(payload['cancellationReason']).toBe('other');
      expect(payload['previousStatus']).toBe('pending');
    });

    it("clamps an out-of-range previousStatus to 'confirmed' (BookingCanceled.previousStatus enum guard)", () => {
      // `completed` is a legal `BookingStatus` value but NOT a legal
      // `BookingCanceled.previousStatus` value (the schema only
      // allows pending|confirmed|in_progress — you cannot cancel a
      // completed booking via the state machine). The helper clamps
      // to 'confirmed' so the payload validates regardless of the
      // upstream caller's discipline.
      const row = makeRow({ status: 'canceled', canceledAt: NOW });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_CANCELED,
        row,
        now: NOW,
        previousStatus: 'completed',
        actorUserId: 'usr_admin_01',
      }) as Record<string, unknown>;

      expect(payload['previousStatus']).toBe('confirmed');
    });

    it('throws when previousStatus is missing', () => {
      const row = makeRow({ status: 'canceled', canceledAt: NOW });
      expect(() =>
        buildTransitionEventPayload({
          eventName: BOOKING_CANCELED,
          row,
          now: NOW,
          actorUserId: 'usr_payer_01',
        }),
      ).toThrow(/requires previousStatus/);
    });

    it('throws when actorUserId is missing', () => {
      const row = makeRow({ status: 'canceled', canceledAt: NOW });
      expect(() =>
        buildTransitionEventPayload({
          eventName: BOOKING_CANCELED,
          row,
          now: NOW,
          previousStatus: 'confirmed',
        }),
      ).toThrow(/requires actorUserId/);
    });
  });

  describe('shared envelope + identifier shape', () => {
    it('forms the eventId from booking id + status + now epoch ms', () => {
      const row = makeRow({ id: 'bkg_99', status: 'in_progress' });
      const payload = buildTransitionEventPayload({
        eventName: BOOKING_IN_PROGRESS,
        row,
        now: NOW,
      }) as Record<string, unknown>;

      expect(payload['eventId']).toBe(`bkg_99.in_progress.${NOW.getTime()}`);
    });

    it('copies the identifier block verbatim from the row across every event branch', () => {
      const row = makeRow({
        id: 'bkg_42',
        householdId: 'hh_42',
        seniorId: 'sr_42',
        providerId: 'pr_42',
        serviceKind: 'personal_chef_visit',
        status: 'in_progress',
      });
      const branches = [BOOKING_IN_PROGRESS, BOOKING_COMPLETED, BOOKING_CONFIRMED] as const;
      for (const eventName of branches) {
        const payload = buildTransitionEventPayload({
          eventName,
          row,
          now: NOW,
        }) as Record<string, unknown>;
        expect(payload['bookingId']).toBe('bkg_42');
        expect(payload['householdId']).toBe('hh_42');
        expect(payload['seniorId']).toBe('sr_42');
        expect(payload['providerId']).toBe('pr_42');
        expect(payload['serviceKind']).toBe('personal_chef_visit');
      }
    });
  });
});
