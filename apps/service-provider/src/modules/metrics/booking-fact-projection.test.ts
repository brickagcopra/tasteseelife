import type {
  BookingCanceled,
  BookingCompleted,
  BookingConfirmed,
  BookingCreated,
  BookingDeclined,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import {
  projectBookingCanceled,
  projectBookingCompleted,
  projectBookingConfirmed,
  projectBookingCreated,
  projectBookingDeclined,
} from './booking-fact-projection';

/**
 * TS-305d — which columns each booking lifecycle event is entitled to
 * fill.
 *
 * The properties that matter are as much about what an event does NOT
 * contribute as what it does: a confirmation is not an outcome, a
 * completion is not a fabricated response instant, and neither a
 * cancellation's actor nor a completion's money reaches this read model
 * at all.
 */

const IDENTIFIERS = {
  bookingId: 'bkg_1',
  householdId: 'hh_1',
  seniorId: 'snr_1',
  providerId: 'prov_1',
  serviceKind: 'chef_visit',
} as const;

describe('projectBookingCreated', () => {
  const payload = {
    ...IDENTIFIERS,
    eventId: 'evt_1',
    occurredAt: '2026-08-01T09:00:00.000Z',
    scheduledStart: '2026-09-01T17:00:00.000Z',
    scheduledEnd: '2026-09-01T19:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 12_000,
    commissionRateBps: 3000,
    commissionAmountMinor: 3_600,
    finalPriceMinor: 12_000,
  } as unknown as BookingCreated;

  it('takes the offer instant from occurredAt, not the schedule — the clock starts when the request reached the provider', () => {
    const contribution = projectBookingCreated(payload);
    expect(contribution.offeredAt?.toISOString()).toBe('2026-08-01T09:00:00.000Z');
  });

  it('contributes no response and no outcome', () => {
    const contribution = projectBookingCreated(payload);
    expect(contribution.respondedAt).toBeUndefined();
    expect(contribution.outcome).toBeUndefined();
  });

  it('carries no household id, senior id or money into the read model', () => {
    const contribution = projectBookingCreated(payload);
    const serialised = JSON.stringify(contribution);
    expect(serialised).not.toContain('hh_1');
    expect(serialised).not.toContain('snr_1');
    expect(serialised).not.toContain('12000');
  });
});

describe('projectBookingConfirmed', () => {
  const payload = {
    ...IDENTIFIERS,
    eventId: 'evt_2',
    occurredAt: '2026-08-01T09:30:00.000Z',
    scheduledStart: '2026-09-01T17:00:00.000Z',
    scheduledEnd: '2026-09-01T19:00:00.000Z',
    confirmedAt: '2026-08-01T09:30:00.000Z',
  } as unknown as BookingConfirmed;

  it('records an acceptance', () => {
    const contribution = projectBookingConfirmed(payload);
    expect(contribution.responseKind).toBe('accepted');
    expect(contribution.respondedAt?.toISOString()).toBe('2026-08-01T09:30:00.000Z');
  });

  it('does NOT record an outcome — an accepted booking has not yet succeeded or failed', () => {
    const contribution = projectBookingConfirmed(payload);
    expect(contribution.outcome).toBeUndefined();
    expect(contribution.outcomeAt).toBeUndefined();
  });
});

describe('projectBookingDeclined', () => {
  function declined(declineKind: string): BookingDeclined {
    return {
      ...IDENTIFIERS,
      eventId: 'evt_3',
      occurredAt: '2026-08-01T09:45:00.000Z',
      scheduledStart: '2026-09-01T17:00:00.000Z',
      scheduledEnd: '2026-09-01T19:00:00.000Z',
      declinedAt: '2026-08-01T09:45:00.000Z',
      declineKind,
      declineReason: 'unavailable',
      declinedByUserId: 'usr_9',
    } as unknown as BookingDeclined;
  }

  it('is both a response and a terminal outcome', () => {
    const contribution = projectBookingDeclined(declined('provider_declined'));
    expect(contribution.responseKind).toBe('declined');
    expect(contribution.outcome).toBe('declined');
    expect(contribution.outcomeAt?.toISOString()).toBe('2026-08-01T09:45:00.000Z');
  });

  it('carries the decline KIND through rather than flattening the three', () => {
    for (const kind of ['provider_declined', 'window_expired', 'admin_declined']) {
      expect(projectBookingDeclined(declined(kind)).declineKind).toBe(kind);
    }
  });
});

describe('projectBookingCompleted', () => {
  const payload = {
    ...IDENTIFIERS,
    eventId: 'evt_4',
    occurredAt: '2026-09-01T19:05:00.000Z',
    completedAt: '2026-09-01T19:05:00.000Z',
    currency: 'USD',
    grossAmountMinor: 12_000,
    providerAmountMinor: 8_400,
    marketplaceAmountMinor: 3_600,
    commissionRateBps: 3000,
  } as unknown as BookingCompleted;

  it('records the outcome', () => {
    const contribution = projectBookingCompleted(payload);
    expect(contribution.outcome).toBe('completed');
    expect(contribution.outcomeAt?.toISOString()).toBe('2026-09-01T19:05:00.000Z');
  });

  it('does NOT backfill a response instant it does not have — an invented one would enter a response-time median', () => {
    const contribution = projectBookingCompleted(payload);
    expect(contribution.respondedAt).toBeUndefined();
    expect(contribution.responseKind).toBeUndefined();
  });

  it('projects none of the money — provider earnings belong to the payouts context', () => {
    const serialised = JSON.stringify(projectBookingCompleted(payload));
    expect(serialised).not.toContain('8400');
    expect(serialised).not.toContain('12000');
    expect(serialised).not.toContain('USD');
  });
});

describe('projectBookingCanceled', () => {
  function canceled(previousStatus: string): BookingCanceled {
    return {
      ...IDENTIFIERS,
      eventId: 'evt_5',
      occurredAt: '2026-08-20T10:00:00.000Z',
      canceledAt: '2026-08-20T10:00:00.000Z',
      previousStatus,
      cancellationReason: 'family_request',
      canceledByUserId: 'usr_42',
    } as unknown as BookingCanceled;
  }

  it('keeps the status the booking was cancelled OUT OF — that is what relates it to the acceptance', () => {
    expect(projectBookingCanceled(canceled('pending')).canceledPreviousStatus).toBe('pending');
    expect(projectBookingCanceled(canceled('confirmed')).canceledPreviousStatus).toBe('confirmed');
  });

  it('does NOT project canceledByUserId — service-provider cannot resolve whose id it is, so a column would look like attribution and not be', () => {
    const contribution = projectBookingCanceled(canceled('confirmed'));
    expect(JSON.stringify(contribution)).not.toContain('usr_42');
  });

  it('keeps the categorical reason, which is already decided by the producer', () => {
    expect(projectBookingCanceled(canceled('confirmed')).cancellationReason).toBe('family_request');
  });
});

describe('every projection', () => {
  it('names the booking and the provider, so any event can create the row', () => {
    const payloads = [
      projectBookingCreated({
        ...IDENTIFIERS,
        occurredAt: '2026-08-01T09:00:00.000Z',
      } as unknown as BookingCreated),
      projectBookingConfirmed({
        ...IDENTIFIERS,
        confirmedAt: '2026-08-01T09:30:00.000Z',
      } as unknown as BookingConfirmed),
      projectBookingDeclined({
        ...IDENTIFIERS,
        declinedAt: '2026-08-01T09:45:00.000Z',
        declineKind: 'provider_declined',
      } as unknown as BookingDeclined),
      projectBookingCompleted({
        ...IDENTIFIERS,
        completedAt: '2026-09-01T19:05:00.000Z',
      } as unknown as BookingCompleted),
      projectBookingCanceled({
        ...IDENTIFIERS,
        canceledAt: '2026-08-20T10:00:00.000Z',
        previousStatus: 'confirmed',
        cancellationReason: 'family_request',
      } as unknown as BookingCanceled),
    ];

    for (const contribution of payloads) {
      expect(contribution.bookingId).toBe('bkg_1');
      expect(contribution.providerId).toBe('prov_1');
    }
  });
});
