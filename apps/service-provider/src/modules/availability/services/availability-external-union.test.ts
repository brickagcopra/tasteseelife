import { describe, expect, it } from 'vitest';

import {
  resolveNextSevenDays,
  windowOccurrenceOverlapsBusy,
  zonedWallClockToUtc,
  type ExternalBusyInterval,
} from './availability.service';

const NY = 'America/New_York';

describe('zonedWallClockToUtc (TS-206)', () => {
  it('resolves an EDT (summer) wall-clock to UTC (offset -4)', () => {
    const utc = zonedWallClockToUtc('2026-05-29', '09:00', NY);
    expect(utc).not.toBeNull();
    expect(utc?.toISOString()).toBe('2026-05-29T13:00:00.000Z');
  });

  it('resolves an EST (winter) wall-clock to UTC (offset -5)', () => {
    const utc = zonedWallClockToUtc('2026-01-15', '09:00', NY);
    expect(utc?.toISOString()).toBe('2026-01-15T14:00:00.000Z');
  });

  it('returns null for an unparseable zone', () => {
    expect(zonedWallClockToUtc('2026-05-29', '09:00', 'Not/AZone')).toBeNull();
  });

  it('returns null for a malformed date/time', () => {
    expect(zonedWallClockToUtc('not-a-date', '09:00', NY)).toBeNull();
  });
});

describe('windowOccurrenceOverlapsBusy (TS-206)', () => {
  // Friday window 09:00–17:00 NY = 13:00–21:00 UTC.
  const busyMidWindow: ExternalBusyInterval = {
    startAt: new Date('2026-05-29T18:00:00.000Z'), // 14:00 NY
    endAt: new Date('2026-05-29T19:00:00.000Z'), // 15:00 NY
  };

  it('returns true when an external commitment overlaps the window', () => {
    expect(windowOccurrenceOverlapsBusy('2026-05-29', '09:00', '17:00', NY, [busyMidWindow])).toBe(
      true,
    );
  });

  it('returns false when the commitment is entirely outside the window', () => {
    const after: ExternalBusyInterval = {
      startAt: new Date('2026-05-29T22:00:00.000Z'), // 18:00 NY, after 17:00
      endAt: new Date('2026-05-29T23:00:00.000Z'),
    };
    expect(windowOccurrenceOverlapsBusy('2026-05-29', '09:00', '17:00', NY, [after])).toBe(false);
  });

  it('treats abutting intervals as non-overlapping (half-open)', () => {
    // Busy ends exactly at the window start (13:00 UTC) → no overlap.
    const abutting: ExternalBusyInterval = {
      startAt: new Date('2026-05-29T12:00:00.000Z'),
      endAt: new Date('2026-05-29T13:00:00.000Z'),
    };
    expect(windowOccurrenceOverlapsBusy('2026-05-29', '09:00', '17:00', NY, [abutting])).toBe(
      false,
    );
  });
});

describe('resolveNextSevenDays external-busy union (TS-206)', () => {
  const from = new Date('2026-05-29T08:00:00.000Z'); // Friday
  const windows = [
    { weekday: 'friday' as const, startTime: '09:00', endTime: '17:00' },
    { weekday: 'saturday' as const, startTime: '10:00', endTime: '14:00' },
  ];

  it('leaves the projection unchanged when no external busy is supplied', () => {
    const entries = resolveNextSevenDays({ from, windows, exceptions: [] });
    expect(entries.map((e) => e.weekday).sort()).toEqual(['friday', 'saturday']);
  });

  it('drops a window occurrence that overlaps an external busy interval', () => {
    const externalBusy: ExternalBusyInterval[] = [
      {
        startAt: new Date('2026-05-29T18:00:00.000Z'),
        endAt: new Date('2026-05-29T19:00:00.000Z'),
      },
    ];
    const entries = resolveNextSevenDays({
      from,
      windows,
      exceptions: [],
      externalBusy,
      timeZone: NY,
    });
    // Friday is busy → dropped; Saturday survives.
    expect(entries.map((e) => e.weekday)).toEqual(['saturday']);
  });

  it('keeps the window when the busy interval falls on a different day', () => {
    const externalBusy: ExternalBusyInterval[] = [
      {
        startAt: new Date('2026-05-30T18:00:00.000Z'),
        endAt: new Date('2026-05-30T19:00:00.000Z'),
      },
    ];
    const entries = resolveNextSevenDays({
      from,
      windows,
      exceptions: [],
      externalBusy,
      timeZone: NY,
    });
    // Saturday 10:00–14:00 NY = 14:00–18:00 UTC; busy 18:00–19:00 abuts → no drop.
    expect(entries.map((e) => e.weekday).sort()).toEqual(['friday', 'saturday']);
  });

  it('does not apply the union without a timeZone', () => {
    const externalBusy: ExternalBusyInterval[] = [
      {
        startAt: new Date('2026-05-29T18:00:00.000Z'),
        endAt: new Date('2026-05-29T19:00:00.000Z'),
      },
    ];
    const entries = resolveNextSevenDays({ from, windows, exceptions: [], externalBusy });
    expect(entries.map((e) => e.weekday).sort()).toEqual(['friday', 'saturday']);
  });
});
