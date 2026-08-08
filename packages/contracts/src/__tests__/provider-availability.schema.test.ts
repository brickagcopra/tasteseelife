import { describe, expect, it } from 'vitest';

import {
  DeleteProviderAvailabilityResponseSchema,
  PROVIDER_AVAILABILITY_EXCEPTIONS_MAX,
  PROVIDER_AVAILABILITY_TIME_REGEX,
  PROVIDER_AVAILABILITY_WEEKDAY_VALUES,
  PROVIDER_AVAILABILITY_WINDOWS_MAX,
  ProviderAvailabilityDateSchema,
  ProviderAvailabilityExceptionSchema,
  ProviderAvailabilityRecordSchema,
  ProviderAvailabilitySnapshotResponseSchema,
  ProviderAvailabilitySummaryEntrySchema,
  ProviderAvailabilitySummarySchema,
  ProviderAvailabilityTimeSchema,
  ProviderAvailabilityWeekdaySchema,
  ProviderAvailabilityWindowSchema,
  UpdateProviderAvailabilityRequestSchema,
  UpdateProviderAvailabilityResponseSchema,
} from '../http/provider-availability.schema';

const ISO_NOW = '2026-05-20T12:00:00.000Z';

describe('ProviderAvailabilityWeekdaySchema', () => {
  it.each(PROVIDER_AVAILABILITY_WEEKDAY_VALUES)('accepts %s', (value) => {
    expect(ProviderAvailabilityWeekdaySchema.parse(value)).toBe(value);
  });

  it('rejects an unknown weekday', () => {
    expect(() => ProviderAvailabilityWeekdaySchema.parse('weekend')).toThrow();
    expect(() => ProviderAvailabilityWeekdaySchema.parse('Monday')).toThrow();
  });

  it('exposes the literal value tuple for downstream catalogues', () => {
    expect(PROVIDER_AVAILABILITY_WEEKDAY_VALUES).toEqual([
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ]);
  });
});

describe('ProviderAvailabilityTimeSchema', () => {
  it.each(['00:00', '09:00', '12:30', '23:59'])('accepts %s', (value) => {
    expect(ProviderAvailabilityTimeSchema.parse(value)).toBe(value);
  });

  it('rejects malformed time strings', () => {
    expect(() => ProviderAvailabilityTimeSchema.parse('24:00')).toThrow();
    expect(() => ProviderAvailabilityTimeSchema.parse('9:00')).toThrow();
    expect(() => ProviderAvailabilityTimeSchema.parse('09:60')).toThrow();
    expect(() => ProviderAvailabilityTimeSchema.parse('noon')).toThrow();
  });

  it('exposes the regex as a constant for downstream re-use', () => {
    expect(PROVIDER_AVAILABILITY_TIME_REGEX.test('07:15')).toBe(true);
    expect(PROVIDER_AVAILABILITY_TIME_REGEX.test('25:00')).toBe(false);
  });
});

describe('ProviderAvailabilityDateSchema', () => {
  it.each(['2026-01-01', '2026-12-31', '2027-02-28'])('accepts %s', (value) => {
    expect(ProviderAvailabilityDateSchema.parse(value)).toBe(value);
  });

  it('rejects malformed date strings', () => {
    expect(() => ProviderAvailabilityDateSchema.parse('2026/05/20')).toThrow();
    expect(() => ProviderAvailabilityDateSchema.parse('2026-13-01')).toThrow();
    expect(() => ProviderAvailabilityDateSchema.parse('2026-00-01')).toThrow();
    expect(() => ProviderAvailabilityDateSchema.parse('2026-05-32')).toThrow();
    expect(() => ProviderAvailabilityDateSchema.parse('not-a-date')).toThrow();
  });
});

describe('ProviderAvailabilityWindowSchema', () => {
  it('accepts a well-formed window', () => {
    const parsed = ProviderAvailabilityWindowSchema.parse({
      weekday: 'monday',
      startTime: '09:00',
      endTime: '13:00',
    });
    expect(parsed.weekday).toBe('monday');
  });

  it('rejects start >= end', () => {
    expect(() =>
      ProviderAvailabilityWindowSchema.parse({
        weekday: 'tuesday',
        startTime: '13:00',
        endTime: '09:00',
      }),
    ).toThrow();
    expect(() =>
      ProviderAvailabilityWindowSchema.parse({
        weekday: 'tuesday',
        startTime: '13:00',
        endTime: '13:00',
      }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      ProviderAvailabilityWindowSchema.parse({
        weekday: 'monday',
        startTime: '09:00',
        endTime: '13:00',
        note: 'breakfast shift',
      }),
    ).toThrow();
  });
});

describe('ProviderAvailabilityExceptionSchema', () => {
  it('accepts a date-only exclusion', () => {
    expect(ProviderAvailabilityExceptionSchema.parse({ date: '2026-12-25' }).date).toBe(
      '2026-12-25',
    );
  });

  it('rejects unknown fields (strict)', () => {
    expect(() =>
      ProviderAvailabilityExceptionSchema.parse({
        date: '2026-12-25',
        reason: 'holiday',
      }),
    ).toThrow();
  });
});

describe('UpdateProviderAvailabilityRequestSchema', () => {
  const baseWindow = (overrides: Record<string, unknown> = {}) => ({
    weekday: 'monday' as const,
    startTime: '09:00',
    endTime: '13:00',
    ...overrides,
  });

  it('accepts an empty request (clear-all)', () => {
    const parsed = UpdateProviderAvailabilityRequestSchema.parse({
      windows: [],
      exceptions: [],
    });
    expect(parsed.windows).toEqual([]);
    expect(parsed.exceptions).toEqual([]);
  });

  it('accepts multiple non-overlapping windows per weekday', () => {
    const parsed = UpdateProviderAvailabilityRequestSchema.parse({
      windows: [
        baseWindow({ startTime: '09:00', endTime: '13:00' }),
        baseWindow({ startTime: '18:00', endTime: '21:00' }),
      ],
      exceptions: [],
    });
    expect(parsed.windows).toHaveLength(2);
  });

  it('rejects overlapping windows on the same weekday', () => {
    expect(() =>
      UpdateProviderAvailabilityRequestSchema.parse({
        windows: [
          baseWindow({ startTime: '09:00', endTime: '13:00' }),
          baseWindow({ startTime: '12:00', endTime: '15:00' }),
        ],
        exceptions: [],
      }),
    ).toThrow();
  });

  it('accepts the same time-of-day across different weekdays', () => {
    const parsed = UpdateProviderAvailabilityRequestSchema.parse({
      windows: [
        baseWindow({ weekday: 'monday', startTime: '09:00', endTime: '13:00' }),
        baseWindow({ weekday: 'tuesday', startTime: '09:00', endTime: '13:00' }),
      ],
      exceptions: [],
    });
    expect(parsed.windows).toHaveLength(2);
  });

  it('rejects duplicate exception dates', () => {
    expect(() =>
      UpdateProviderAvailabilityRequestSchema.parse({
        windows: [],
        exceptions: [{ date: '2026-12-25' }, { date: '2026-12-25' }],
      }),
    ).toThrow();
  });

  it('rejects an over-cap windows array', () => {
    const tooMany = Array.from({ length: PROVIDER_AVAILABILITY_WINDOWS_MAX + 1 }, (_, i) =>
      baseWindow({
        startTime: `0${(i % 6).toString()}:00`,
        endTime: `0${((i % 6) + 1).toString()}:00`,
      }),
    );
    expect(() =>
      UpdateProviderAvailabilityRequestSchema.parse({
        windows: tooMany,
        exceptions: [],
      }),
    ).toThrow();
  });

  it('rejects an over-cap exceptions array', () => {
    const tooMany = Array.from({ length: PROVIDER_AVAILABILITY_EXCEPTIONS_MAX + 1 }, (_, i) => ({
      date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`,
    }));
    expect(() =>
      UpdateProviderAvailabilityRequestSchema.parse({
        windows: [],
        exceptions: tooMany,
      }),
    ).toThrow();
  });

  it('rejects unknown top-level fields (strict)', () => {
    expect(() =>
      UpdateProviderAvailabilityRequestSchema.parse({
        windows: [],
        exceptions: [],
        timeZone: 'America/New_York',
      }),
    ).toThrow();
  });
});

describe('ProviderAvailabilityRecordSchema', () => {
  const validRecord = {
    providerId: 'prov_abc',
    timeZone: 'America/New_York',
    windows: [{ weekday: 'monday' as const, startTime: '09:00', endTime: '13:00' }],
    exceptions: [{ date: '2026-12-25' }],
    updatedAt: ISO_NOW,
  };

  it('parses a well-formed record', () => {
    const parsed = ProviderAvailabilityRecordSchema.parse(validRecord);
    expect(parsed.providerId).toBe('prov_abc');
    expect(parsed.windows).toHaveLength(1);
    expect(parsed.exceptions).toHaveLength(1);
  });

  it('rejects an invalid updatedAt', () => {
    expect(() =>
      ProviderAvailabilityRecordSchema.parse({ ...validRecord, updatedAt: 'oops' }),
    ).toThrow();
  });

  it('rejects unknown fields (strict)', () => {
    expect(() => ProviderAvailabilityRecordSchema.parse({ ...validRecord, extra: true })).toThrow();
  });
});

describe('ProviderAvailabilitySnapshotResponseSchema', () => {
  it('accepts the null-availability branch', () => {
    expect(
      ProviderAvailabilitySnapshotResponseSchema.parse({ availability: null }).availability,
    ).toBeNull();
  });

  it('accepts a populated branch', () => {
    const parsed = ProviderAvailabilitySnapshotResponseSchema.parse({
      availability: {
        providerId: 'prov_abc',
        timeZone: 'America/New_York',
        windows: [],
        exceptions: [],
        updatedAt: ISO_NOW,
      },
    });
    expect(parsed.availability?.providerId).toBe('prov_abc');
  });
});

describe('UpdateProviderAvailabilityResponseSchema', () => {
  it('wraps the record in `{ availability: ... }`', () => {
    const parsed = UpdateProviderAvailabilityResponseSchema.parse({
      availability: {
        providerId: 'prov_abc',
        timeZone: 'America/New_York',
        windows: [],
        exceptions: [],
        updatedAt: ISO_NOW,
      },
    });
    expect(parsed.availability.providerId).toBe('prov_abc');
  });
});

describe('DeleteProviderAvailabilityResponseSchema', () => {
  it('accepts non-negative counts', () => {
    const parsed = DeleteProviderAvailabilityResponseSchema.parse({
      providerId: 'prov_abc',
      deletedWindowCount: 3,
      deletedExceptionCount: 1,
    });
    expect(parsed.deletedWindowCount).toBe(3);
  });

  it('accepts zero deletions (no-op delete)', () => {
    const parsed = DeleteProviderAvailabilityResponseSchema.parse({
      providerId: 'prov_abc',
      deletedWindowCount: 0,
      deletedExceptionCount: 0,
    });
    expect(parsed.deletedWindowCount).toBe(0);
  });

  it('rejects negative counts', () => {
    expect(() =>
      DeleteProviderAvailabilityResponseSchema.parse({
        providerId: 'prov_abc',
        deletedWindowCount: -1,
        deletedExceptionCount: 0,
      }),
    ).toThrow();
  });
});

describe('ProviderAvailabilitySummaryEntrySchema', () => {
  it('parses a single resolved entry', () => {
    const parsed = ProviderAvailabilitySummaryEntrySchema.parse({
      date: '2026-05-21',
      weekday: 'thursday',
      startTime: '09:00',
      endTime: '13:00',
    });
    expect(parsed.date).toBe('2026-05-21');
  });

  it('rejects malformed time-of-day', () => {
    expect(() =>
      ProviderAvailabilitySummaryEntrySchema.parse({
        date: '2026-05-21',
        weekday: 'thursday',
        startTime: '9am',
        endTime: '1pm',
      }),
    ).toThrow();
  });
});

describe('ProviderAvailabilitySummarySchema', () => {
  it('parses a well-formed summary', () => {
    const parsed = ProviderAvailabilitySummarySchema.parse({
      timeZone: 'America/New_York',
      entries: [
        {
          date: '2026-05-21',
          weekday: 'thursday',
          startTime: '09:00',
          endTime: '13:00',
        },
      ],
      generatedAt: '2026-05-20T12:00:00.000Z',
    });
    expect(parsed.entries).toHaveLength(1);
  });

  it('rejects an entry list over the cap', () => {
    const tooMany = Array.from({ length: 29 }, (_, i) => ({
      date: `2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`,
      weekday: 'monday' as const,
      startTime: '09:00',
      endTime: '10:00',
    }));
    expect(() =>
      ProviderAvailabilitySummarySchema.parse({
        timeZone: 'America/New_York',
        entries: tooMany,
        generatedAt: '2026-05-20T12:00:00.000Z',
      }),
    ).toThrow();
  });
});
