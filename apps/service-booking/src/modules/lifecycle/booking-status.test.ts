import { describe, expect, it } from 'vitest';

import {
  BOOKING_STATUSES,
  BOOKING_STATUS_TRANSITIONS,
  isBookingStatus,
  TERMINAL_BOOKING_STATUSES,
  type BookingStatus,
} from './booking-status';

/**
 * Unit suite for the declarative pieces — the const tuple, the type
 * guard, the transition table, and the derived terminal-set. The
 * service-level behaviour (`canTransition` / `validateTransition` /
 * `isTerminal` / `allowedTransitions`) is exercised in the sibling
 * service test.
 */
describe('booking-status declarative pieces', () => {
  it('BOOKING_STATUSES enumerates exactly the six PRD-defined states (incl. TS-205 declined)', () => {
    expect([...BOOKING_STATUSES]).toEqual([
      'pending',
      'confirmed',
      'in_progress',
      'completed',
      'canceled',
      'declined',
    ]);
  });

  describe('isBookingStatus', () => {
    it('returns true for every known status', () => {
      for (const status of BOOKING_STATUSES) {
        expect(isBookingStatus(status)).toBe(true);
      }
    });

    it('returns false for unknown strings', () => {
      for (const candidate of ['', 'PENDING', 'unknown', 'COMPLETED', 'in-progress']) {
        expect(isBookingStatus(candidate)).toBe(false);
      }
    });

    it('returns false for non-string inputs', () => {
      for (const candidate of [null, undefined, 42, true, {}, [], Symbol('x')]) {
        expect(isBookingStatus(candidate)).toBe(false);
      }
    });
  });

  describe('BOOKING_STATUS_TRANSITIONS', () => {
    it('declares an entry for every status', () => {
      for (const status of BOOKING_STATUSES) {
        expect(BOOKING_STATUS_TRANSITIONS[status]).toBeDefined();
      }
    });

    it('encodes the PDD §9.2 / PRD §6.3 + TS-205 transition diagram exactly', () => {
      // pending → {confirmed, canceled, declined}
      expect([...BOOKING_STATUS_TRANSITIONS.pending].sort()).toEqual([
        'canceled',
        'confirmed',
        'declined',
      ]);
      // confirmed → {in_progress, canceled}
      expect([...BOOKING_STATUS_TRANSITIONS.confirmed].sort()).toEqual(['canceled', 'in_progress']);
      // in_progress → {completed, canceled}
      expect([...BOOKING_STATUS_TRANSITIONS.in_progress].sort()).toEqual(['canceled', 'completed']);
      // completed → terminal
      expect([...BOOKING_STATUS_TRANSITIONS.completed]).toEqual([]);
      // canceled → terminal
      expect([...BOOKING_STATUS_TRANSITIONS.canceled]).toEqual([]);
      // declined → terminal (TS-205)
      expect([...BOOKING_STATUS_TRANSITIONS.declined]).toEqual([]);
    });

    it('every declared destination is itself a known status (no dangling edges)', () => {
      for (const status of BOOKING_STATUSES) {
        for (const dest of BOOKING_STATUS_TRANSITIONS[status]) {
          expect(BOOKING_STATUSES).toContain(dest);
        }
      }
    });

    it('no edge loops back to its source (self-loops are not legal)', () => {
      for (const status of BOOKING_STATUSES) {
        expect(BOOKING_STATUS_TRANSITIONS[status]).not.toContain(status as BookingStatus);
      }
    });

    it('table is deeply frozen — accidental mutation throws', () => {
      expect(Object.isFrozen(BOOKING_STATUS_TRANSITIONS)).toBe(true);
      for (const status of BOOKING_STATUSES) {
        expect(Object.isFrozen(BOOKING_STATUS_TRANSITIONS[status])).toBe(true);
      }
    });
  });

  describe('TERMINAL_BOOKING_STATUSES', () => {
    it('derives the terminal set from zero-outgoing-edges entries in the table', () => {
      expect([...TERMINAL_BOOKING_STATUSES].sort()).toEqual(['canceled', 'completed', 'declined']);
    });

    it('every terminal status has zero outgoing transitions, and every non-terminal has at least one', () => {
      for (const status of BOOKING_STATUSES) {
        if (TERMINAL_BOOKING_STATUSES.has(status)) {
          expect(BOOKING_STATUS_TRANSITIONS[status].length).toBe(0);
        } else {
          expect(BOOKING_STATUS_TRANSITIONS[status].length).toBeGreaterThan(0);
        }
      }
    });
  });
});
