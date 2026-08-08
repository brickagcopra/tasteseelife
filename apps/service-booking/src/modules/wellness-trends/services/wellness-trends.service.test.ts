import { WELLNESS_TREND_METRICS, WELLNESS_TREND_MAX_VISITS } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { WellnessTrendsService } from './wellness-trends.service';

interface BookingSeed {
  readonly id: string;
  readonly scheduledStart: Date;
}

interface VisitNoteSeed {
  readonly bookingId: string;
  readonly mood: string | null;
  readonly appetite: string | null;
  readonly hydration: string | null;
  readonly socialEngagement: string | null;
  readonly recordedAt: Date;
}

class FakePrisma {
  /** Seeded oldest → newest; the service queries desc + reverses. */
  public bookings: BookingSeed[] = [];
  public visitNotes: VisitNoteSeed[] = [];
  public countWhere: Record<string, unknown> | null = null;
  public findManyArgs: { where: Record<string, unknown>; take: number; orderBy: unknown } | null =
    null;
  public visitNoteFindManyArgs: { where: { bookingId: { in: string[] } } } | null = null;

  booking = {
    count: vi.fn(async (args: { where: Record<string, unknown> }) => {
      this.countWhere = args.where;
      return this.bookings.length;
    }),
    findMany: vi.fn(
      async (args: { where: Record<string, unknown>; take: number; orderBy: unknown }) => {
        this.findManyArgs = args;
        // The service asks for desc order; return newest-first, capped.
        const desc = [...this.bookings].sort(
          (a, b) => b.scheduledStart.getTime() - a.scheduledStart.getTime(),
        );
        return desc.slice(0, args.take) as unknown[];
      },
    ),
  };

  bookingVisitNote = {
    findMany: vi.fn(async (args: { where: { bookingId: { in: string[] } } }) => {
      this.visitNoteFindManyArgs = args;
      const ids = new Set(args.where.bookingId.in);
      return this.visitNotes.filter((note) => ids.has(note.bookingId)) as unknown[];
    }),
  };
}

function makeService(prisma: FakePrisma): WellnessTrendsService {
  return new WellnessTrendsService(prisma as unknown as PrismaService);
}

function note(overrides: Partial<VisitNoteSeed> & { bookingId: string }): VisitNoteSeed {
  return {
    mood: null,
    appetite: null,
    hydration: null,
    socialEngagement: null,
    recordedAt: new Date('2026-05-20T18:00:00.000Z'),
    ...overrides,
  };
}

describe('WellnessTrendsService.loadTrends', () => {
  it('scopes the query to household + senior + completed within the window', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);

    await service.loadTrends({ householdId: 'hh_1', seniorId: 'snr_1', windowDays: 30 });

    expect(prisma.findManyArgs?.where['householdId']).toBe('hh_1');
    expect(prisma.findManyArgs?.where['seniorId']).toBe('snr_1');
    expect(prisma.findManyArgs?.where['status']).toBe('completed');
    expect(prisma.findManyArgs?.where['scheduledStart']).toHaveProperty('gte');
    // count + findMany share the identical where so the denominator
    // can't drift from the scan.
    expect(prisma.countWhere).toEqual(prisma.findManyArgs?.where);
    expect(prisma.findManyArgs?.orderBy).toEqual([{ scheduledStart: 'desc' }, { id: 'desc' }]);
    expect(prisma.findManyArgs?.take).toBe(WELLNESS_TREND_MAX_VISITS);
  });

  it('returns all four scales in fixed order, even when none recorded', async () => {
    const prisma = new FakePrisma();
    const service = makeService(prisma);

    const result = await service.loadTrends({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 90,
    });

    expect(result.series.map((s) => s.metric)).toEqual([...WELLNESS_TREND_METRICS]);
    for (const series of result.series) {
      expect(series.points).toEqual([]);
      expect(series.latestScore).toBeNull();
      expect(series.visitsRecorded).toBe(0);
    }
    expect(result.totalCompletedVisits).toBe(0);
    expect(result.windowDays).toBe(90);
    expect(result.seniorId).toBe('snr_1');
  });

  it('plots per-visit points in chronological order with the ordinal score', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [
      { id: 'bkg_1', scheduledStart: new Date('2026-05-10T17:00:00.000Z') },
      { id: 'bkg_2', scheduledStart: new Date('2026-05-15T17:00:00.000Z') },
      { id: 'bkg_3', scheduledStart: new Date('2026-05-20T17:00:00.000Z') },
    ];
    prisma.visitNotes = [
      note({ bookingId: 'bkg_1', mood: 'low' }),
      note({ bookingId: 'bkg_2', mood: 'neutral' }),
      note({ bookingId: 'bkg_3', mood: 'joyful' }),
    ];
    const service = makeService(prisma);

    const result = await service.loadTrends({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });

    const mood = result.series.find((s) => s.metric === 'mood')!;
    expect(mood.points.map((p) => p.bookingId)).toEqual(['bkg_1', 'bkg_2', 'bkg_3']);
    expect(mood.points.map((p) => p.score)).toEqual([1, 3, 5]);
    expect(mood.points.map((p) => p.level)).toEqual(['low', 'neutral', 'joyful']);
    expect(mood.points[0]!.visitDate).toBe('2026-05-10T17:00:00.000Z');
    expect(mood.latestScore).toBe(5);
    expect(mood.visitsRecorded).toBe(3);
    expect(result.totalCompletedVisits).toBe(3);
  });

  it('omits a visit from a scale when that scale was left blank', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [
      { id: 'bkg_1', scheduledStart: new Date('2026-05-10T17:00:00.000Z') },
      { id: 'bkg_2', scheduledStart: new Date('2026-05-15T17:00:00.000Z') },
    ];
    prisma.visitNotes = [
      note({ bookingId: 'bkg_1', appetite: 'hearty' }), // no mood
      note({ bookingId: 'bkg_2', mood: 'bright', appetite: 'moderate' }),
    ];
    const service = makeService(prisma);

    const result = await service.loadTrends({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });

    const mood = result.series.find((s) => s.metric === 'mood')!;
    const appetite = result.series.find((s) => s.metric === 'appetite')!;
    expect(mood.points.map((p) => p.bookingId)).toEqual(['bkg_2']);
    expect(mood.visitsRecorded).toBe(1);
    expect(appetite.points.map((p) => p.bookingId)).toEqual(['bkg_1', 'bkg_2']);
    expect(appetite.points.map((p) => p.score)).toEqual([4, 3]);
    // A visit that recorded no scale at all still counts toward the total.
    expect(result.totalCompletedVisits).toBe(2);
  });

  it('skips a booking with no visit-note row entirely', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [
      { id: 'bkg_1', scheduledStart: new Date('2026-05-10T17:00:00.000Z') },
      { id: 'bkg_2', scheduledStart: new Date('2026-05-15T17:00:00.000Z') },
    ];
    prisma.visitNotes = [note({ bookingId: 'bkg_2', hydration: 'good' })];
    const service = makeService(prisma);

    const result = await service.loadTrends({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });

    const hydration = result.series.find((s) => s.metric === 'hydration')!;
    expect(hydration.points.map((p) => p.bookingId)).toEqual(['bkg_2']);
    expect(hydration.points[0]!.score).toBe(4);
  });

  it('batches the visit-note read into a single findMany keyed by booking ids', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [
      { id: 'bkg_1', scheduledStart: new Date('2026-05-10T17:00:00.000Z') },
      { id: 'bkg_2', scheduledStart: new Date('2026-05-15T17:00:00.000Z') },
    ];
    prisma.visitNotes = [
      note({ bookingId: 'bkg_1', mood: 'bright' }),
      note({ bookingId: 'bkg_2', mood: 'subdued' }),
    ];
    const service = makeService(prisma);

    await service.loadTrends({ householdId: 'hh_1', seniorId: 'snr_1', windowDays: 30 });

    expect(prisma.bookingVisitNote.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.visitNoteFindManyArgs?.where.bookingId.in.sort()).toEqual(['bkg_1', 'bkg_2']);
  });

  it('defends against an unknown stored level (never plots a null score)', async () => {
    const prisma = new FakePrisma();
    prisma.bookings = [{ id: 'bkg_1', scheduledStart: new Date('2026-05-10T17:00:00.000Z') }];
    prisma.visitNotes = [note({ bookingId: 'bkg_1', mood: 'ecstatic' })]; // not a real level
    const service = makeService(prisma);

    const result = await service.loadTrends({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 30,
    });

    const mood = result.series.find((s) => s.metric === 'mood')!;
    expect(mood.points).toEqual([]);
    expect(mood.latestScore).toBeNull();
  });
});
