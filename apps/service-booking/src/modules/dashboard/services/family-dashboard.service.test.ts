import type { BookingServiceKind } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import type { BookingRecord } from '../../bookings/services/bookings.service';
import { FamilyDashboardService } from './family-dashboard.service';

function makeRow(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'bkg_1',
    householdId: 'hh_abc',
    seniorId: 'snr_abc',
    providerId: 'prv_abc',
    serviceKind: 'companion_dining' as BookingServiceKind,
    status: 'completed',
    scheduledStart: new Date('2026-05-18T17:00:00.000Z'),
    scheduledEnd: new Date('2026-05-18T19:00:00.000Z'),
    currency: 'USD',
    basePrice: { toString: () => '150.00' },
    commissionRate: { toString: () => '0.2000' },
    commissionAmount: { toString: () => '30.00' },
    finalPrice: { toString: () => '150.00' },
    bookingNotes: null,
    completedAt: new Date('2026-05-18T19:05:00.000Z'),
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    acceptWindowExpiresAt: null,
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    heldByIncidentId: null,
    createdAt: new Date('2026-05-10T12:00:00.000Z'),
    updatedAt: new Date('2026-05-18T19:05:00.000Z'),
    ...overrides,
  };
}

interface VisitNoteSeed {
  readonly bookingId: string;
  readonly mood: string | null;
  readonly appetite: string | null;
  readonly hydration: string | null;
  readonly socialEngagement: string | null;
  readonly freeform: string | null;
  readonly photoKeys: readonly string[];
  readonly recordedAt: Date;
}

class FakePrisma {
  public upcomingRows: BookingRecord[] = [];
  public historyRows: BookingRecord[] = [];
  public visitNotes: VisitNoteSeed[] = [];
  public bookingFindManyArgs: { where: Record<string, unknown>; take: number; orderBy: unknown }[] =
    [];
  public visitNoteFindManyArgs: { where: { bookingId: { in: string[] } } }[] = [];

  booking = {
    findMany: vi.fn(
      async (args: { where: Record<string, unknown>; take: number; orderBy: unknown }) => {
        this.bookingFindManyArgs.push(args);
        // Distinguish the two reads by the status predicate: the
        // upcoming read uses `status: { in: [...] }`, the history read
        // uses `status: 'completed'`.
        if (args.where['status'] === 'completed') {
          return this.historyRows as unknown[];
        }
        return this.upcomingRows as unknown[];
      },
    ),
  };

  bookingVisitNote = {
    findMany: vi.fn(async (args: { where: { bookingId: { in: string[] } } }) => {
      this.visitNoteFindManyArgs.push(args);
      const ids = new Set(args.where.bookingId.in);
      return this.visitNotes.filter((note) => ids.has(note.bookingId)) as unknown[];
    }),
  };
}

function makeService(prisma: FakePrisma): FamilyDashboardService {
  return new FamilyDashboardService(prisma as unknown as PrismaService);
}

describe('FamilyDashboardService.loadDashboard', () => {
  it('queries upcoming with the non-terminal status set, scheduledEnd>=now, and a window ceiling', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);
    await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: undefined,
      historyLimit: 10,
    });

    const upcomingArgs = prisma.bookingFindManyArgs[0]!;
    expect(upcomingArgs.where['householdId']).toBe('hh_abc');
    expect(upcomingArgs.where['status']).toEqual({ in: ['pending', 'confirmed', 'in_progress'] });
    expect(upcomingArgs.where['scheduledEnd']).toHaveProperty('gte');
    expect(upcomingArgs.where['scheduledStart']).toHaveProperty('lte');
    expect(upcomingArgs.orderBy).toEqual([{ scheduledStart: 'asc' }, { id: 'asc' }]);
    expect(upcomingArgs.take).toBe(50);
  });

  it('queries history for completed-only, newest-first, with limit+1 to detect more', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);
    await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 7,
      historyCursor: undefined,
      historyLimit: 10,
    });

    const historyArgs = prisma.bookingFindManyArgs[1]!;
    expect(historyArgs.where['status']).toBe('completed');
    expect(historyArgs.orderBy).toEqual([{ scheduledStart: 'desc' }, { id: 'desc' }]);
    expect(historyArgs.take).toBe(11);
  });

  it('applies the seniorId filter to both lists when provided', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);
    await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: 'snr_xyz',
      windowDays: 90,
      historyCursor: undefined,
      historyLimit: 10,
    });
    expect(prisma.bookingFindManyArgs[0]!.where['seniorId']).toBe('snr_xyz');
    expect(prisma.bookingFindManyArgs[1]!.where['seniorId']).toBe('snr_xyz');
  });

  it('echoes seniorId=null for the combined view', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);
    const result = await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: undefined,
      historyLimit: 10,
    });
    expect(result.seniorId).toBeNull();
    expect(result.householdId).toBe('hh_abc');
    expect(result.windowDays).toBe(30);
  });

  it('inlines a visit-note summary with photoCount (never raw keys) and null when no notes exist', async () => {
    const prisma = new FakePrisma();
    prisma.historyRows = [makeRow({ id: 'bkg_1' }), makeRow({ id: 'bkg_2' })];
    prisma.visitNotes = [
      {
        bookingId: 'bkg_1',
        mood: 'bright',
        appetite: 'hearty',
        hydration: 'good',
        socialEngagement: 'engaged',
        freeform: 'Lovely afternoon.',
        photoKeys: ['k1', 'k2', 'k3'],
        recordedAt: new Date('2026-05-18T19:00:00.000Z'),
      },
    ];
    const service = makeService(prisma);
    const result = await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: undefined,
      historyLimit: 10,
    });

    expect(result.history).toHaveLength(2);
    const withNotes = result.history.find((v) => v.booking.id === 'bkg_1');
    const withoutNotes = result.history.find((v) => v.booking.id === 'bkg_2');
    expect(withNotes?.visitNotes).toEqual({
      mood: 'bright',
      appetite: 'hearty',
      hydration: 'good',
      socialEngagement: 'engaged',
      freeform: 'Lovely afternoon.',
      photoCount: 3,
      recordedAt: '2026-05-18T19:00:00.000Z',
    });
    expect((withNotes?.visitNotes as Record<string, unknown>)['photoKeys']).toBeUndefined();
    expect(withoutNotes?.visitNotes).toBeNull();
  });

  it('makes exactly one batched visit-note read keyed by the page booking ids (no N+1)', async () => {
    const prisma = new FakePrisma();
    prisma.historyRows = [
      makeRow({ id: 'bkg_1' }),
      makeRow({ id: 'bkg_2' }),
      makeRow({ id: 'bkg_3' }),
    ];
    const service = makeService(prisma);
    await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: undefined,
      historyLimit: 10,
    });
    expect(prisma.bookingVisitNote.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.visitNoteFindManyArgs[0]!.where.bookingId.in).toEqual([
      'bkg_1',
      'bkg_2',
      'bkg_3',
    ]);
  });

  it('skips the visit-note read entirely when there is no history', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);
    const result = await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: undefined,
      historyLimit: 10,
    });
    expect(result.history).toEqual([]);
    expect(prisma.bookingVisitNote.findMany).not.toHaveBeenCalled();
  });

  it('returns a non-null historyNextCursor when more completed visits exist beyond the limit', async () => {
    const prisma = new FakePrisma();
    prisma.historyRows = [
      makeRow({ id: 'bkg_1', scheduledStart: new Date('2026-05-18T17:00:00.000Z') }),
      makeRow({ id: 'bkg_2', scheduledStart: new Date('2026-05-11T17:00:00.000Z') }),
      makeRow({ id: 'bkg_3', scheduledStart: new Date('2026-05-04T17:00:00.000Z') }),
    ];
    const service = makeService(prisma);
    const result = await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: undefined,
      historyLimit: 2,
    });
    expect(result.history.map((v) => v.booking.id)).toEqual(['bkg_1', 'bkg_2']);
    expect(result.historyNextCursor).not.toBeNull();
    expect(typeof result.historyNextCursor).toBe('string');
  });

  it('decodes a valid history cursor into the (scheduledStart, id) tie-break predicate', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);
    const raw = Buffer.from('2026-05-18T17:00:00.000Z|bkg_xyz').toString('base64url');
    await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: raw,
      historyLimit: 10,
    });
    const where = prisma.bookingFindManyArgs[1]!.where as { OR?: unknown[] };
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR!.length).toBe(2);
  });

  it('ignores an unparseable history cursor (treats it as no cursor)', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);
    await service.loadDashboard({
      householdId: 'hh_abc',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: 'not-a-real-cursor',
      historyLimit: 10,
    });
    const where = prisma.bookingFindManyArgs[1]!.where as { OR?: unknown[] };
    expect(where.OR).toBeUndefined();
  });
});
