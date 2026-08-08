import { describe, expect, it } from 'vitest';

import { QuietHoursService, isMinuteInRange, minuteOfDayInTimeZone } from './quiet-hours.service';

describe('isMinuteInRange', () => {
  it('handles a same-day window', () => {
    expect(isMinuteInRange(720, 720, 840)).toBe(true); // 12:00 ∈ [12:00, 14:00)
    expect(isMinuteInRange(839, 720, 840)).toBe(true); // 13:59 ∈ [12:00, 14:00)
    expect(isMinuteInRange(840, 720, 840)).toBe(false); // 14:00 ∉ [12:00, 14:00)
    expect(isMinuteInRange(719, 720, 840)).toBe(false); // 11:59 ∉ [12:00, 14:00)
  });

  it('handles a wrap-around window (21:00 → 08:00)', () => {
    expect(isMinuteInRange(1260, 1260, 480)).toBe(true); // 21:00 inclusive
    expect(isMinuteInRange(0, 1260, 480)).toBe(true); // midnight
    expect(isMinuteInRange(479, 1260, 480)).toBe(true); // 07:59
    expect(isMinuteInRange(480, 1260, 480)).toBe(false); // 08:00 exclusive
    expect(isMinuteInRange(720, 1260, 480)).toBe(false); // 12:00 outside
    expect(isMinuteInRange(1259, 1260, 480)).toBe(false); // 20:59 outside
  });
});

describe('minuteOfDayInTimeZone', () => {
  it('returns null for an invalid IANA identifier', () => {
    expect(minuteOfDayInTimeZone(new Date('2026-05-16T15:00:00Z'), 'Not/A_Zone')).toBeNull();
  });

  it('converts a UTC moment to NYC local minutes', () => {
    // 2026-05-16 15:00 UTC = 11:00 EDT (DST in effect, UTC-4)
    const m = minuteOfDayInTimeZone(new Date('2026-05-16T15:00:00Z'), 'America/New_York');
    expect(m).toBe(11 * 60);
  });

  it('handles the DST fall-back ambiguity by picking the canonical local time', () => {
    // 2026-11-01 05:30 UTC = 01:30 EDT (before the fall-back), which
    // resolves to 01:30 (or 00:30, depending on Node's choice). The
    // implementation must produce a finite number, not throw.
    const m = minuteOfDayInTimeZone(new Date('2026-11-01T05:30:00Z'), 'America/New_York');
    expect(typeof m).toBe('number');
    expect(m).not.toBeNull();
  });
});

describe('QuietHoursService.isInQuietHours', () => {
  const svc = new QuietHoursService();
  const nycWindow = {
    startMinuteOfDay: 1260, // 21:00
    endMinuteOfDay: 480, // 08:00
    timeZone: 'America/New_York',
  };

  it('returns no_window when window is null', () => {
    expect(svc.isInQuietHours(new Date('2026-05-16T03:00:00Z'), null)).toEqual({
      inWindow: false,
      reason: 'no_window',
    });
  });

  it('detects an in-window time (02:00 EDT)', () => {
    // 2026-05-16 06:00 UTC = 02:00 EDT — well inside 21:00-08:00 window
    const result = svc.isInQuietHours(new Date('2026-05-16T06:00:00Z'), nycWindow);
    expect(result.inWindow).toBe(true);
    expect(result.reason).toBe('in_window');
  });

  it('detects an outside-window time (12:00 EDT)', () => {
    // 2026-05-16 16:00 UTC = 12:00 EDT — outside the 21:00-08:00 window
    const result = svc.isInQuietHours(new Date('2026-05-16T16:00:00Z'), nycWindow);
    expect(result.inWindow).toBe(false);
    expect(result.reason).toBe('outside_window');
  });

  it('treats start time as inclusive', () => {
    // 2026-05-16 01:00 UTC = 21:00 EDT (previous day) — boundary
    const result = svc.isInQuietHours(new Date('2026-05-17T01:00:00Z'), nycWindow);
    expect(result.inWindow).toBe(true);
  });

  it('treats end time as exclusive', () => {
    // 2026-05-16 12:00 UTC = 08:00 EDT — boundary; exclusive
    const result = svc.isInQuietHours(new Date('2026-05-16T12:00:00Z'), nycWindow);
    expect(result.inWindow).toBe(false);
  });

  it('returns invalid_time_zone when TZ is bogus', () => {
    const result = svc.isInQuietHours(new Date('2026-05-16T03:00:00Z'), {
      startMinuteOfDay: 1260,
      endMinuteOfDay: 480,
      timeZone: 'Not/A_Zone',
    });
    expect(result.inWindow).toBe(false);
    expect(result.reason).toBe('invalid_time_zone');
  });

  it('handles a same-day window', () => {
    const napWindow = {
      startMinuteOfDay: 12 * 60, // 12:00
      endMinuteOfDay: 14 * 60, // 14:00
      timeZone: 'UTC',
    };
    expect(svc.isInQuietHours(new Date('2026-05-16T12:30:00Z'), napWindow).inWindow).toBe(true);
    expect(svc.isInQuietHours(new Date('2026-05-16T14:00:00Z'), napWindow).inWindow).toBe(false);
    expect(svc.isInQuietHours(new Date('2026-05-16T11:59:00Z'), napWindow).inWindow).toBe(false);
  });
});
