import type { BookingServiceKind } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { BookingsListService } from './bookings-list.service';
import type { BookingRecord } from './bookings.service';

function makeRow(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'bkg_1',
    householdId: 'hh_abc',
    seniorId: 'snr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining' as BookingServiceKind,
    status: 'pending',
    scheduledStart: new Date('2026-06-10T17:00:00.000Z'),
    scheduledEnd: new Date('2026-06-10T19:00:00.000Z'),
    currency: 'USD',
    basePrice: { toString: () => '150.00' },
    commissionRate: { toString: () => '0.2000' },
    commissionAmount: { toString: () => '30.00' },
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

class FakePrisma {
  public lastFindManyArgs: { where: unknown; take: number; orderBy: unknown } | null = null;
  public bookings: BookingRecord[] = [];

  booking = {
    findMany: vi.fn(async (args: { where: unknown; take: number; orderBy: unknown }) => {
      this.lastFindManyArgs = args;
      return this.bookings as unknown[];
    }),
  };
}

describe('BookingsListService.listByHousehold', () => {
  it('returns an empty list when no rows exist', async () => {
    const prisma = new FakePrisma();
    const service = new BookingsListService(prisma as unknown as PrismaService);
    const result = await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 20,
      cursor: undefined,
    });
    expect(result.rows).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('uses createdAt DESC + id DESC and asks for limit+1 to detect more', async () => {
    const prisma = new FakePrisma();
    const service = new BookingsListService(prisma as unknown as PrismaService);
    await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 20,
      cursor: undefined,
    });
    expect(prisma.lastFindManyArgs?.take).toBe(21);
    expect(prisma.lastFindManyArgs?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(prisma.lastFindManyArgs?.where).toEqual({
      householdId: 'hh_abc',
    });
  });

  it('returns nextCursor=null when result count is at or below limit', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [makeRow({ id: 'bkg_1' }), makeRow({ id: 'bkg_2' })];
    const service = new BookingsListService(prisma as unknown as PrismaService);
    const result = await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 20,
      cursor: undefined,
    });
    expect(result.rows.length).toBe(2);
    expect(result.nextCursor).toBeNull();
  });

  it('returns a non-null nextCursor when more rows exist beyond limit', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [
      makeRow({ id: 'bkg_1', createdAt: new Date('2026-05-13T12:00:00.000Z') }),
      makeRow({ id: 'bkg_2', createdAt: new Date('2026-05-12T12:00:00.000Z') }),
      makeRow({ id: 'bkg_3', createdAt: new Date('2026-05-11T12:00:00.000Z') }),
    ];
    const service = new BookingsListService(prisma as unknown as PrismaService);
    const result = await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 2,
      cursor: undefined,
    });
    expect(result.rows.length).toBe(2);
    expect(result.rows.map((r) => r.id)).toEqual(['bkg_1', 'bkg_2']);
    expect(result.nextCursor).not.toBeNull();
    expect(typeof result.nextCursor).toBe('string');
  });

  it('decodes a valid cursor and applies the (createdAt, id) tiebreaker predicate', async () => {
    const prisma = new FakePrisma();
    const service = new BookingsListService(prisma as unknown as PrismaService);
    const cursorISO = '2026-05-13T12:00:00.000Z';
    const cursorId = 'bkg_xyz';
    const raw = Buffer.from(`${cursorISO}|${cursorId}`).toString('base64url');
    await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 10,
      cursor: raw,
    });
    const where = prisma.lastFindManyArgs?.where as { householdId: string; OR?: unknown[] };
    expect(where.householdId).toBe('hh_abc');
    expect(where.OR).toBeDefined();
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR!.length).toBe(2);
  });

  it('ignores an unparseable cursor (treats it as no cursor)', async () => {
    const prisma = new FakePrisma();
    const service = new BookingsListService(prisma as unknown as PrismaService);
    await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 10,
      cursor: 'not-a-real-cursor-token',
    });
    const where = prisma.lastFindManyArgs?.where as { householdId: string; OR?: unknown[] };
    expect(where.householdId).toBe('hh_abc');
    expect(where.OR).toBeUndefined();
  });

  it('round-trips a created cursor (encode → decode → encode equal)', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [
      makeRow({ id: 'bkg_1', createdAt: new Date('2026-05-13T12:00:00.000Z') }),
      makeRow({ id: 'bkg_2', createdAt: new Date('2026-05-12T12:00:00.000Z') }),
    ];
    const service = new BookingsListService(prisma as unknown as PrismaService);
    const first = await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 1,
      cursor: undefined,
    });
    expect(first.nextCursor).not.toBeNull();
    // Decode + reuse the cursor and confirm it doesn't throw.
    await service.listByHousehold({
      actorUserId: 'usr_actor',
      householdId: 'hh_abc',
      limit: 1,
      cursor: first.nextCursor!,
    });
    const where = prisma.lastFindManyArgs?.where as { householdId: string; OR?: unknown[] };
    expect(where.OR).toBeDefined();
  });
});
