import { describe, expect, it } from 'vitest';

import { BookingLifecycleService } from './booking-lifecycle.service';
import {
  BOOKING_STATUSES,
  BOOKING_STATUS_TRANSITIONS,
  TERMINAL_BOOKING_STATUSES,
  type BookingStatus,
  type InvalidTransitionError,
} from './booking-status';

/**
 * Exhaustive cell-by-cell coverage of the (from × to) matrix so a
 * silent change to the transition table is impossible. The matrix is
 * small enough (6 × 6 = 36 cells, post-TS-205) to enumerate; bigger
 * state machines would push to a property-based generator, but a
 * literal table here is more readable as a spec.
 *
 * Expected legal transitions (per PRD §6.3 + PDD §9.2 + TS-205):
 *
 *   pending     → confirmed
 *   pending     → canceled
 *   pending     → declined   (TS-205 — provider declines OR auto-decline
 *                             worker fires after accept window expiry)
 *   confirmed   → in_progress
 *   confirmed   → canceled
 *   in_progress → completed
 *   in_progress → canceled
 *
 * Everything else (including self-loops and any transition out of
 * completed / canceled / declined) is illegal.
 */
const EXPECTED_LEGAL_TRANSITIONS: ReadonlyArray<readonly [BookingStatus, BookingStatus]> = [
  ['pending', 'confirmed'],
  ['pending', 'canceled'],
  ['pending', 'declined'],
  ['confirmed', 'in_progress'],
  ['confirmed', 'canceled'],
  ['in_progress', 'completed'],
  ['in_progress', 'canceled'],
];

function isExpectedLegal(from: BookingStatus, to: BookingStatus): boolean {
  return EXPECTED_LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to);
}

describe('BookingLifecycleService', () => {
  const service = new BookingLifecycleService();

  describe('canTransition — exhaustive 6×6 matrix', () => {
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        const expected = isExpectedLegal(from, to);
        it(`${from} → ${to}: ${expected ? 'legal' : 'illegal'}`, () => {
          expect(service.canTransition(from, to)).toBe(expected);
        });
      }
    }
  });

  describe('canTransition — same-state edges are never legal', () => {
    for (const status of BOOKING_STATUSES) {
      it(`${status} → ${status} returns false`, () => {
        expect(service.canTransition(status, status)).toBe(false);
      });
    }
  });

  describe('canTransition — terminal states have no legal outgoing edges', () => {
    for (const terminal of TERMINAL_BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        it(`${terminal} → ${to} returns false`, () => {
          expect(service.canTransition(terminal, to)).toBe(false);
        });
      }
    }
  });

  describe('validateTransition', () => {
    it('returns ok for every expected legal transition', () => {
      for (const [from, to] of EXPECTED_LEGAL_TRANSITIONS) {
        const result = service.validateTransition(from, to);
        expect(result.ok).toBe(true);
      }
    });

    it('returns InvalidTransitionError carrying from/to/allowed for an illegal transition', () => {
      const result = service.validateTransition('completed', 'pending');
      expect(result.ok).toBe(false);
      if (result.ok) return; // narrow for ts
      const error: InvalidTransitionError = result.error;
      expect(error.kind).toBe('invalid_transition');
      expect(error.from).toBe('completed');
      expect(error.to).toBe('pending');
      expect(error.allowed).toEqual(BOOKING_STATUS_TRANSITIONS.completed);
      expect(error.allowed.length).toBe(0);
    });

    it('returns InvalidTransitionError for a self-transition with the legal set populated', () => {
      const result = service.validateTransition('pending', 'pending');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const error: InvalidTransitionError = result.error;
      expect(error.from).toBe('pending');
      expect(error.to).toBe('pending');
      expect([...error.allowed].sort()).toEqual(['canceled', 'confirmed', 'declined']);
    });

    it('returns InvalidTransitionError carrying allowed transitions for an illegal mid-state edge', () => {
      // confirmed → completed is illegal (must go through in_progress)
      const result = service.validateTransition('confirmed', 'completed');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const error: InvalidTransitionError = result.error;
      expect(error.from).toBe('confirmed');
      expect(error.to).toBe('completed');
      expect([...error.allowed].sort()).toEqual(['canceled', 'in_progress']);
    });

    it('returned `allowed` array is a reference to the frozen table (callers must not mutate)', () => {
      const result = service.validateTransition('canceled', 'pending');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The error's `allowed` array is the frozen entry from the
      // transition table. Confirm by attempting a mutation — the
      // table is frozen, so a strict-mode push throws.
      expect(Object.isFrozen(result.error.allowed)).toBe(true);
    });
  });

  describe('isTerminal', () => {
    it('returns true exactly for completed, canceled, and declined', () => {
      for (const status of BOOKING_STATUSES) {
        const expected = status === 'completed' || status === 'canceled' || status === 'declined';
        expect(service.isTerminal(status)).toBe(expected);
      }
    });
  });

  describe('allowedTransitions', () => {
    it('returns the table entry for every status', () => {
      for (const status of BOOKING_STATUSES) {
        expect(service.allowedTransitions(status)).toBe(BOOKING_STATUS_TRANSITIONS[status]);
      }
    });

    it('returns an empty array for terminal states', () => {
      for (const terminal of TERMINAL_BOOKING_STATUSES) {
        expect(service.allowedTransitions(terminal)).toEqual([]);
      }
    });
  });
});
