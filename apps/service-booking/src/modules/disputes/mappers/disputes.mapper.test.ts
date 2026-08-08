import { describe, expect, it } from 'vitest';

import type { DisputeRecord } from '../services/disputes.service';
import { toBookingDisputeResponse } from './disputes.mapper';

/**
 * Unit suite for `toBookingDisputeResponse` (TS-065).
 *
 * The mapper is pure — given a `DisputeRecord` row it returns the
 * matching `BookingDisputeResponse` DTO. Tests cover the open shape
 * (nullable resolution columns) and the terminal shape (resolution
 * columns populated), plus the optional `reasonDetail` column.
 */
describe('toBookingDisputeResponse', () => {
  const SEED_OPEN: DisputeRecord = {
    id: 'dsp_1',
    bookingId: 'bkg_1',
    openedByUserId: 'usr_family',
    openedByRole: 'family',
    reason: 'service_quality',
    reasonDetail: 'Cold meal.',
    status: 'open',
    resolutionNotes: null,
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: new Date('2026-05-14T18:00:00.000Z'),
    updatedAt: new Date('2026-05-14T18:00:00.000Z'),
  };

  it('maps an open dispute row to the DTO shape', () => {
    const result = toBookingDisputeResponse(SEED_OPEN);
    expect(result).toEqual({
      id: 'dsp_1',
      bookingId: 'bkg_1',
      openedByUserId: 'usr_family',
      openedByRole: 'family',
      reason: 'service_quality',
      reasonDetail: 'Cold meal.',
      status: 'open',
      resolutionNotes: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: '2026-05-14T18:00:00.000Z',
      updatedAt: '2026-05-14T18:00:00.000Z',
    });
  });

  it('echoes null reasonDetail when the opener did not supply one', () => {
    const row: DisputeRecord = { ...SEED_OPEN, reasonDetail: null };
    const result = toBookingDisputeResponse(row);
    expect(result.reasonDetail).toBeNull();
  });

  it('serialises the resolution timestamp when terminal', () => {
    const row: DisputeRecord = {
      ...SEED_OPEN,
      status: 'resolved',
      resolutionNotes: 'Refunded $100.',
      resolvedByUserId: 'usr_ops',
      resolvedAt: new Date('2026-05-14T19:00:00.000Z'),
    };
    const result = toBookingDisputeResponse(row);
    expect(result.status).toBe('resolved');
    expect(result.resolutionNotes).toBe('Refunded $100.');
    expect(result.resolvedByUserId).toBe('usr_ops');
    expect(result.resolvedAt).toBe('2026-05-14T19:00:00.000Z');
  });

  it('handles dismissed terminal shape identically to resolved', () => {
    const row: DisputeRecord = {
      ...SEED_OPEN,
      status: 'dismissed',
      resolutionNotes: 'Unfounded.',
      resolvedByUserId: 'usr_ops',
      resolvedAt: new Date('2026-05-14T19:30:00.000Z'),
    };
    const result = toBookingDisputeResponse(row);
    expect(result.status).toBe('dismissed');
    expect(result.resolvedAt).toBe('2026-05-14T19:30:00.000Z');
  });
});
