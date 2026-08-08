import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import {
  AdminBookingsService,
  decodeCursor,
  encodeCursor,
  type AdminBookingCheckInRow,
  type AdminBookingDisputeRow,
  type AdminBookingRow,
  type AdminBookingVisitNoteRow,
} from './admin-bookings.service';

const NOW = new Date('2026-05-18T12:00:00.000Z');
const EARLIER = new Date('2026-05-17T12:00:00.000Z');

/** Lightweight Decimal stand-in: just a `toString()` surface. */
function decimal(value: string): { toString(): string } {
  return { toString: () => value };
}

function buildBookingRow(overrides: Partial<AdminBookingRow> = {}): AdminBookingRow {
  const base: AdminBookingRow = {
    id: overrides.id ?? 'bkg_default',
    householdId: overrides.householdId ?? 'hh_a',
    seniorId: overrides.seniorId ?? 'sen_a',
    providerId: overrides.providerId ?? 'pro_a',
    serviceKind: overrides.serviceKind ?? 'companion_dining',
    status: overrides.status ?? 'confirmed',
    scheduledStart: overrides.scheduledStart ?? new Date('2026-06-01T12:00:00.000Z'),
    scheduledEnd: overrides.scheduledEnd ?? new Date('2026-06-01T14:00:00.000Z'),
    currency: overrides.currency ?? 'USD',
    basePrice: overrides.basePrice ?? decimal('150.00'),
    commissionRate: overrides.commissionRate ?? decimal('0.20'),
    commissionAmount: overrides.commissionAmount ?? decimal('30.00'),
    finalPrice: overrides.finalPrice ?? decimal('150.00'),
    bookingNotes: overrides.bookingNotes ?? null,
    completedAt: overrides.completedAt ?? null,
    canceledAt: overrides.canceledAt ?? null,
    cancellationReason: overrides.cancellationReason ?? null,
    cancellationReasonText: overrides.cancellationReasonText ?? null,
    seriesId: overrides.seriesId ?? null,
    seriesIndex: overrides.seriesIndex ?? null,
    heldByIncidentId: null,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
  return base;
}

/** Tiny stub prisma surface — only the surfaces the admin service hits. */
function buildPrismaStub(opts: {
  bookingFindMany?: (args: unknown) => Promise<AdminBookingRow[]>;
  bookingFindUnique?: (args: unknown) => Promise<AdminBookingRow | null>;
  visitNoteFindUnique?: (args: unknown) => Promise<AdminBookingVisitNoteRow | null>;
  checkInsFindMany?: (args: unknown) => Promise<AdminBookingCheckInRow[]>;
  disputesFindMany?: (args: unknown) => Promise<AdminBookingDisputeRow[]>;
  recurrenceFindUnique?: (args: unknown) => Promise<unknown | null>;
}): PrismaService {
  const stub = {
    booking: {
      findMany: vi.fn(opts.bookingFindMany ?? (async () => [])),
      findUnique: vi.fn(opts.bookingFindUnique ?? (async () => null)),
    },
    bookingVisitNote: {
      findUnique: vi.fn(opts.visitNoteFindUnique ?? (async () => null)),
    },
    bookingCheckIn: {
      findMany: vi.fn(opts.checkInsFindMany ?? (async () => [])),
    },
    bookingDispute: {
      findMany: vi.fn(opts.disputesFindMany ?? (async () => [])),
    },
    bookingRecurrence: {
      findUnique: vi.fn(opts.recurrenceFindUnique ?? (async () => null)),
    },
  };
  return stub as unknown as PrismaService;
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a (createdAt, id) pair', () => {
    const encoded = encodeCursor(NOW, 'bkg_abc');
    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.createdAt.getTime()).toBe(NOW.getTime());
    expect(decoded?.id).toBe('bkg_abc');
  });

  it('returns null on undefined input', () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('returns null on malformed base64', () => {
    expect(decodeCursor('!!!not-base64')).toBeNull();
  });

  it('returns null on missing pipe delimiter', () => {
    const bad = Buffer.from('no-pipe-here', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null on invalid ISO date', () => {
    const bad = Buffer.from('not-a-date|bkg_x', 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });

  it('returns null on empty id', () => {
    const bad = Buffer.from(`${NOW.toISOString()}|`, 'utf8').toString('base64url');
    expect(decodeCursor(bad)).toBeNull();
  });
});

describe('AdminBookingsService.list', () => {
  it('returns an empty page when no bookings match', async () => {
    const prisma = buildPrismaStub({ bookingFindMany: async () => [] });
    const service = new AdminBookingsService(prisma);
    const page = await service.list({ limit: 25 });
    expect(page.bookings).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('emits no cursor when the page is not full', async () => {
    const rows = [buildBookingRow({ id: 'bkg_1', createdAt: NOW })];
    const prisma = buildPrismaStub({ bookingFindMany: async () => rows });
    const service = new AdminBookingsService(prisma);
    const page = await service.list({ limit: 25 });
    expect(page.bookings).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('emits a nextCursor when the page is full', async () => {
    // Prisma returns limit+1 = 3 rows; service trims to 2 and emits cursor for the second.
    const rows = [
      buildBookingRow({ id: 'bkg_1', createdAt: new Date('2026-05-18T12:00:00.000Z') }),
      buildBookingRow({ id: 'bkg_2', createdAt: new Date('2026-05-17T12:00:00.000Z') }),
      buildBookingRow({ id: 'bkg_3', createdAt: new Date('2026-05-16T12:00:00.000Z') }),
    ];
    const prisma = buildPrismaStub({ bookingFindMany: async () => rows });
    const service = new AdminBookingsService(prisma);
    const page = await service.list({ limit: 2 });
    expect(page.bookings).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeCursor(page.nextCursor!);
    expect(decoded?.id).toBe('bkg_2');
  });

  it('forwards every filter into the prisma where-clause', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<AdminBookingRow[]> => []);
    const prisma = buildPrismaStub({ bookingFindMany: findMany });
    const service = new AdminBookingsService(prisma);
    await service.list({
      householdId: 'hh_a',
      providerId: 'pro_a',
      seniorId: 'sen_a',
      serviceKind: 'companion_dining',
      status: 'confirmed',
      limit: 50,
    });
    const callArgs = findMany.mock.calls[0];
    const args = (callArgs !== undefined ? callArgs[0] : {}) as {
      where: Record<string, unknown>;
      take: number;
    };
    expect(args.where).toMatchObject({
      householdId: 'hh_a',
      providerId: 'pro_a',
      seniorId: 'sen_a',
      serviceKind: 'companion_dining',
      status: 'confirmed',
    });
    expect(args.take).toBe(51); // limit + 1
  });

  it('honors the cursor by emitting an OR predicate', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<AdminBookingRow[]> => []);
    const prisma = buildPrismaStub({ bookingFindMany: findMany });
    const service = new AdminBookingsService(prisma);
    const cursor = encodeCursor(NOW, 'bkg_x');
    await service.list({ cursor, limit: 25 });
    const callArgs = findMany.mock.calls[0];
    const args = (callArgs !== undefined ? callArgs[0] : {}) as {
      where: Record<string, unknown>;
    };
    expect(args.where).toHaveProperty('OR');
  });

  it('clamps limit at MAX_LIMIT (100)', async () => {
    const findMany = vi.fn(async (_args: unknown): Promise<AdminBookingRow[]> => []);
    const prisma = buildPrismaStub({ bookingFindMany: findMany });
    const service = new AdminBookingsService(prisma);
    await service.list({ limit: 9_999 });
    const callArgs = findMany.mock.calls[0];
    const args = (callArgs !== undefined ? callArgs[0] : {}) as { take: number };
    expect(args.take).toBe(101); // 100 + 1
  });

  it('returns isRecurring flag derived from seriesId — at the mapper, not here', async () => {
    // The service surface returns raw rows; mapping is the controller's
    // responsibility. We just verify the seriesId field round-trips.
    const rows = [buildBookingRow({ id: 'bkg_1', seriesId: 'ser_a', seriesIndex: 0 })];
    const prisma = buildPrismaStub({ bookingFindMany: async () => rows });
    const service = new AdminBookingsService(prisma);
    const page = await service.list({ limit: 25 });
    expect(page.bookings[0]?.seriesId).toBe('ser_a');
    expect(page.bookings[0]?.seriesIndex).toBe(0);
  });
});

describe('AdminBookingsService.getById', () => {
  it('returns null when the booking does not resolve', async () => {
    const prisma = buildPrismaStub({ bookingFindUnique: async () => null });
    const service = new AdminBookingsService(prisma);
    const row = await service.getById({ bookingId: 'bkg_missing' });
    expect(row).toBeNull();
  });

  it('returns a hydrated detail row with visit note / check-ins / disputes', async () => {
    const booking = buildBookingRow({ id: 'bkg_a', status: 'completed' });
    const visitNote: AdminBookingVisitNoteRow = {
      id: 'note_a',
      mood: 'bright',
      appetite: 'hearty',
      hydration: 'good',
      socialEngagement: 'engaged',
      freeform: 'Notes here',
      photoKeys: [],
      recordedByUserId: 'usr_pro_a',
      recordedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const checkIn: AdminBookingCheckInRow = {
      id: 'chk_a',
      kind: 'check_in',
      latitude: decimal('40.776676'),
      longitude: decimal('-73.971990'),
      locationAccuracyMeters: decimal('12.50'),
      occurredAt: EARLIER,
      recordedByUserId: 'usr_pro_a',
      createdAt: EARLIER,
    };
    const dispute: AdminBookingDisputeRow = {
      id: 'disp_a',
      openedByUserId: 'usr_fam_a',
      openedByRole: 'family',
      reason: 'service_quality',
      reasonDetail: null,
      status: 'open',
      resolutionNotes: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: EARLIER,
      updatedAt: EARLIER,
    };

    const prisma = buildPrismaStub({
      bookingFindUnique: async () => booking,
      visitNoteFindUnique: async () => visitNote,
      checkInsFindMany: async () => [checkIn],
      disputesFindMany: async () => [dispute],
    });
    const service = new AdminBookingsService(prisma);
    const row = await service.getById({ bookingId: 'bkg_a' });
    expect(row).not.toBeNull();
    expect(row?.visitNote?.id).toBe('note_a');
    expect(row?.checkIns).toHaveLength(1);
    expect(row?.disputes).toHaveLength(1);
    expect(row?.recurrence).toBeNull();
  });

  it('reads the recurrence row when the booking has a seriesId', async () => {
    const booking = buildBookingRow({
      id: 'bkg_a',
      seriesId: 'ser_a',
      seriesIndex: 2,
    });
    const recurrence = {
      seriesId: 'ser_a',
      rrule: 'FREQ=WEEKLY;INTERVAL=1;COUNT=12',
      endDate: null,
      count: 12,
      occurrenceCount: 12,
      createdAt: EARLIER,
      updatedAt: EARLIER,
    };
    const prisma = buildPrismaStub({
      bookingFindUnique: async () => booking,
      recurrenceFindUnique: async () => recurrence,
    });
    const service = new AdminBookingsService(prisma);
    const row = await service.getById({ bookingId: 'bkg_a' });
    expect(row?.recurrence?.seriesId).toBe('ser_a');
    expect(row?.recurrence?.seriesIndex).toBe(2);
    expect(row?.recurrence?.count).toBe(12);
  });

  it('does NOT call bookingRecurrence.findUnique when seriesId is null', async () => {
    const booking = buildBookingRow({ id: 'bkg_a', seriesId: null });
    const recurrenceSpy = vi.fn(async () => null);
    const prisma = buildPrismaStub({
      bookingFindUnique: async () => booking,
      recurrenceFindUnique: recurrenceSpy,
    });
    const service = new AdminBookingsService(prisma);
    const row = await service.getById({ bookingId: 'bkg_a' });
    expect(row?.recurrence).toBeNull();
    expect(recurrenceSpy).not.toHaveBeenCalled();
  });

  it('returns null recurrence when seriesId is set but recurrence row is missing', async () => {
    const booking = buildBookingRow({
      id: 'bkg_a',
      seriesId: 'ser_missing',
      seriesIndex: 0,
    });
    const prisma = buildPrismaStub({
      bookingFindUnique: async () => booking,
      recurrenceFindUnique: async () => null,
    });
    const service = new AdminBookingsService(prisma);
    const row = await service.getById({ bookingId: 'bkg_a' });
    expect(row?.recurrence).toBeNull();
  });
});
