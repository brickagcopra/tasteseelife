import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AdminBookingsController } from './admin-bookings.controller';
import type {
  AdminBookingDetailRow,
  AdminBookingListPage,
  AdminBookingRow,
  AdminBookingsService,
} from '../services/admin-bookings.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const LATER = new Date('2026-05-18T14:00:00.000Z');

function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

function buildRow(overrides: Partial<AdminBookingRow> = {}): AdminBookingRow {
  return {
    id: 'bkg_a',
    householdId: 'hh_a',
    seniorId: 'sen_a',
    providerId: 'pro_a',
    serviceKind: 'companion_dining',
    status: 'confirmed',
    scheduledStart: NOW,
    scheduledEnd: LATER,
    currency: 'USD',
    basePrice: decimal('150.00'),
    commissionRate: decimal('0.20'),
    commissionAmount: decimal('30.00'),
    finalPrice: decimal('150.00'),
    bookingNotes: null,
    completedAt: null,
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    seriesId: null,
    seriesIndex: null,
    heldByIncidentId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildService(opts: {
  list?: () => Promise<AdminBookingListPage>;
  getById?: () => Promise<AdminBookingDetailRow | null>;
}): AdminBookingsService {
  return {
    list: vi.fn(opts.list ?? (async () => ({ bookings: [], nextCursor: null }))),
    getById: vi.fn(opts.getById ?? (async () => null)),
  } as unknown as AdminBookingsService;
}

describe('AdminBookingsController.list', () => {
  it('returns an empty list when the service returns nothing', async () => {
    const service = buildService({});
    const controller = new AdminBookingsController(service);
    const result = await controller.list({ limit: 25 });
    expect(result.bookings).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('mirrors service rows onto contract DTOs with ISO timestamps', async () => {
    const row = buildRow({
      id: 'bkg_1',
      seriesId: 'ser_a',
      seriesIndex: 0,
      basePrice: decimal('250.00'),
      commissionRate: decimal('0.30'),
      commissionAmount: decimal('75.00'),
      finalPrice: decimal('250.00'),
    });
    const service = buildService({
      list: async () => ({ bookings: [row], nextCursor: 'next_x' }),
    });
    const controller = new AdminBookingsController(service);
    const result = await controller.list({ limit: 25 });
    expect(result.bookings).toHaveLength(1);
    const dto = result.bookings[0]!;
    expect(dto.id).toBe('bkg_1');
    expect(dto.scheduledStart).toBe(NOW.toISOString());
    expect(dto.basePriceMinor).toBe(25_000);
    expect(dto.commissionRateBps).toBe(3_000);
    expect(dto.commissionAmountMinor).toBe(7_500);
    expect(dto.finalPriceMinor).toBe(25_000);
    expect(dto.isRecurring).toBe(true);
    expect(result.nextCursor).toBe('next_x');
  });

  it('forwards filters into the service call', async () => {
    const listSpy = vi.fn(async () => ({ bookings: [], nextCursor: null }));
    const service = buildService({ list: listSpy });
    const controller = new AdminBookingsController(service);
    await controller.list({
      householdId: 'hh_a',
      providerId: 'pro_a',
      seniorId: 'sen_a',
      serviceKind: 'companion_dining',
      status: 'confirmed',
      cursor: 'cur',
      limit: 50,
    });
    expect(listSpy).toHaveBeenCalledWith({
      householdId: 'hh_a',
      providerId: 'pro_a',
      seniorId: 'sen_a',
      serviceKind: 'companion_dining',
      status: 'confirmed',
      cursor: 'cur',
      limit: 50,
    });
  });

  it('omits undefined filters from the service call', async () => {
    const listSpy = vi.fn(async () => ({ bookings: [], nextCursor: null }));
    const service = buildService({ list: listSpy });
    const controller = new AdminBookingsController(service);
    await controller.list({ limit: 25 });
    expect(listSpy).toHaveBeenCalledWith({ limit: 25 });
  });
});

describe('AdminBookingsController.getById', () => {
  it('throws 404 on empty id', async () => {
    const service = buildService({});
    const controller = new AdminBookingsController(service);
    await expect(controller.getById('')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 on over-long id', async () => {
    const service = buildService({});
    const controller = new AdminBookingsController(service);
    await expect(controller.getById('x'.repeat(1000))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 when the service returns null', async () => {
    const service = buildService({ getById: async () => null });
    const controller = new AdminBookingsController(service);
    await expect(controller.getById('bkg_unknown')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a hydrated detail row to the contract envelope', async () => {
    const row = buildRow({ id: 'bkg_a', status: 'completed', completedAt: LATER });
    const detail: AdminBookingDetailRow = {
      ...row,
      visitNote: {
        id: 'note_a',
        mood: 'bright',
        appetite: 'hearty',
        hydration: 'good',
        socialEngagement: 'engaged',
        freeform: 'Lovely visit',
        photoKeys: ['media_x'],
        recordedByUserId: 'usr_pro_a',
        recordedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      checkIns: [
        {
          id: 'chk_a',
          kind: 'check_in',
          latitude: decimal('40.776676'),
          longitude: decimal('-73.971990'),
          locationAccuracyMeters: decimal('12.50'),
          occurredAt: NOW,
          recordedByUserId: 'usr_pro_a',
          createdAt: NOW,
        },
      ],
      disputes: [],
      recurrence: null,
    };
    const service = buildService({ getById: async () => detail });
    const controller = new AdminBookingsController(service);
    const result = await controller.getById('bkg_a');
    expect(result.booking.id).toBe('bkg_a');
    expect(result.booking.visitNote?.mood).toBe('bright');
    expect(result.booking.checkIns).toHaveLength(1);
    expect(result.booking.checkIns[0]?.latitude).toBeCloseTo(40.776676);
    expect(result.booking.disputes).toEqual([]);
    expect(result.booking.recurrence).toBeNull();
    expect(result.booking.completedAt).toBe(LATER.toISOString());
  });
});
