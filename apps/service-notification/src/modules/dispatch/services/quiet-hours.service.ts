import { Injectable } from '@nestjs/common';
import type { QuietHoursWindow } from '@taste-and-see/contracts';

/**
 * Quiet-hours computation (TS-073).
 *
 * Pure logic that decides whether a given `Date` falls inside a user's
 * quiet-hours window, accounting for:
 *
 *   - **IANA time-zone**. The window minutes are local-time, so the
 *     gate converts the UTC `now` into the user's local time via
 *     `Intl.DateTimeFormat` before comparing. This correctly handles
 *     DST shifts without ambiguity (a 21:00–08:00 window covers the
 *     extra hour on the fall-back night, and the missing hour on the
 *     spring-forward night).
 *
 *   - **Wrap-around windows**. The dominant senior-mode case (21:00 to
 *     next-day 08:00) has `start > end`. The contract layer rejects
 *     zero-width windows; everything else is fair game.
 *
 *   - **Same-day windows**. `start < end` (e.g. 12:00 to 14:00 nap
 *     time). Treated naturally by the comparison.
 *
 * **Falsey time-zone behaviour.** An invalid IANA identifier (caught
 * by Intl) returns `notInWindow` — fail-open so a misconfigured TZ
 * doesn't silently lock a user out of their notifications.
 */
@Injectable()
export class QuietHoursService {
  /**
   * Is `now` inside the user's quiet-hours window?
   *
   * Returns `null` when no window is configured (caller treats as
   * "not in window").
   */
  isInQuietHours(now: Date, window: QuietHoursWindow | null): QuietHoursDecision {
    if (window === null) {
      return { inWindow: false, reason: 'no_window' };
    }

    const minutesLocal = minuteOfDayInTimeZone(now, window.timeZone);
    if (minutesLocal === null) {
      // Invalid IANA TZ — fail open. The dispatch orchestrator emits an
      // `info`-level log so ops can investigate.
      return { inWindow: false, reason: 'invalid_time_zone' };
    }

    const { startMinuteOfDay: start, endMinuteOfDay: end } = window;
    const inWindow = isMinuteInRange(minutesLocal, start, end);
    return { inWindow, reason: inWindow ? 'in_window' : 'outside_window' };
  }
}

export interface QuietHoursDecision {
  readonly inWindow: boolean;
  readonly reason: 'in_window' | 'outside_window' | 'no_window' | 'invalid_time_zone';
}

/**
 * Minute-of-day in the named IANA time-zone. Returns null when the
 * time-zone is invalid. Exported for unit-test access.
 */
export function minuteOfDayInTimeZone(date: Date, timeZone: string): number | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === 'hour');
    const minutePart = parts.find((p) => p.type === 'minute');
    if (!hourPart || !minutePart) return null;
    const hour = Number.parseInt(hourPart.value, 10);
    const minute = Number.parseInt(minutePart.value, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Is `minute` inside the [start, end) interval? Handles wrap-around
 * when `start > end`.
 */
export function isMinuteInRange(minute: number, start: number, end: number): boolean {
  if (start < end) {
    return minute >= start && minute < end;
  }
  // Wrap-around: minute >= start OR minute < end
  return minute >= start || minute < end;
}
