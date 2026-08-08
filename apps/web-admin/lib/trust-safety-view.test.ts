import type { BookingHoldRow } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import { deadlineLabel, groupByIncident, isSignoffBlockedByFourEyes } from './trust-safety-view';

/**
 * Tests for the trust & safety console's decision helpers
 * (TS-303c2b-followup-1a). Before the extraction all three were reachable
 * only through a server component and covered by nothing.
 */

function hold(overrides: Partial<BookingHoldRow> = {}): BookingHoldRow {
  return {
    incidentId: 'inc_1',
    subjectKind: 'provider',
    subjectId: 'prv_1',
    heldAt: '2026-07-26T10:00:00.000Z',
    releasedAt: null,
    severity: 'high',
    category: 'safety',
    incidentSuspendedBookingCount: 4,
    ...overrides,
  } as BookingHoldRow;
}

describe('isSignoffBlockedByFourEyes', () => {
  it('BLOCKS the signoff for the operator who opened the case', () => {
    expect(
      isSignoffBlockedByFourEyes({
        to: 'signed_off',
        openedByUserId: 'usr_1',
        actorUserId: 'usr_1',
      }),
    ).toBe(true);
  });

  it('allows the signoff for a different operator', () => {
    expect(
      isSignoffBlockedByFourEyes({
        to: 'signed_off',
        openedByUserId: 'usr_1',
        actorUserId: 'usr_2',
      }),
    ).toBe(false);
  });

  it.each(['filing_prep', 'filed', 'not_reportable'] as const)(
    "does NOT gate %s — every other transition is one operator's to make",
    (to) => {
      // Gating them all would stall a case whenever its opener is the
      // only person on shift, which on a filing deadline is the opposite
      // of safe. Only the determination needs a second pair of eyes.
      expect(
        isSignoffBlockedByFourEyes({ to, openedByUserId: 'usr_1', actorUserId: 'usr_1' }),
      ).toBe(false);
    },
  );
});

describe('deadlineLabel', () => {
  const NOW = Date.parse('2026-07-27T12:00:00.000Z');

  it('a NULL deadline is an explicit compliance gap, styled overdue', () => {
    // The state's window is not in the jurisdiction kit, so we do not
    // know when this filing is due. That is a reason to act, not to
    // relax, and it must never render as "no deadline" or as blank.
    expect(deadlineLabel(null, NOW)).toEqual({
      text: 'state window not established',
      className: 'concierge-sla concierge-sla--overdue',
    });
  });

  it('an UNREADABLE deadline is treated the same way, never as Invalid Date', () => {
    expect(deadlineLabel('not-a-timestamp', NOW).text).toBe('deadline unreadable');
    expect(deadlineLabel('not-a-timestamp', NOW).className).toContain('overdue');
  });

  it('counts down in hours inside two days', () => {
    expect(deadlineLabel('2026-07-28T12:00:00.000Z', NOW).text).toBe('due in 24h');
  });

  it('switches to days at 48 hours', () => {
    expect(deadlineLabel('2026-07-30T12:00:00.000Z', NOW).text).toBe('due in 3d');
  });

  it('reports elapsed time once the deadline has passed, styled overdue', () => {
    const label = deadlineLabel('2026-07-27T06:00:00.000Z', NOW);

    expect(label.text).toBe('deadline passed 6h ago');
    expect(label.className).toContain('overdue');
  });

  it('a live deadline is not styled overdue', () => {
    expect(deadlineLabel('2026-07-28T12:00:00.000Z', NOW).className).toBe('concierge-sla');
  });
});

describe('groupByIncident', () => {
  it('groups the adjacent rows of one incident', () => {
    const groups = groupByIncident([
      hold({ subjectKind: 'provider' }),
      hold({ subjectKind: 'senior', subjectId: 'sen_1' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toHaveLength(2);
  });

  it('states the per-incident suspended count ONCE per group', () => {
    // `incidentSuspendedBookingCount` is per-incident, not per-row
    // (TS-304-followup-3). Repeated on every row it would be summed by
    // eye into a number several times too large.
    const groups = groupByIncident([
      hold(),
      hold({ subjectKind: 'senior' }),
      hold({ subjectKind: 'household' }),
    ]);

    expect(groups[0]?.suspendedBookingCount).toBe(4);
  });

  it('PRESERVES the API row order rather than re-sorting by insertion', () => {
    const groups = groupByIncident([
      hold({ incidentId: 'inc_b' }),
      hold({ incidentId: 'inc_a' }),
      hold({ incidentId: 'inc_c' }),
    ]);

    expect(groups.map((g) => g.incidentId)).toEqual(['inc_b', 'inc_a', 'inc_c']);
  });

  it('starts a NEW group when an incident reappears non-adjacently', () => {
    // A map-based bucketing would silently merge these two runs and put
    // the group somewhere the API never ordered it.
    const groups = groupByIncident([
      hold({ incidentId: 'inc_a' }),
      hold({ incidentId: 'inc_b' }),
      hold({ incidentId: 'inc_a' }),
    ]);

    expect(groups.map((g) => g.incidentId)).toEqual(['inc_a', 'inc_b', 'inc_a']);
  });

  it('takes severity and category from the first row of the group', () => {
    const groups = groupByIncident([
      hold({ severity: 'critical', category: 'welfare' }),
      hold({ severity: 'high', category: 'safety' }),
    ]);

    expect(groups[0]?.severity).toBe('critical');
    expect(groups[0]?.category).toBe('welfare');
  });

  it('an empty list is an empty list', () => {
    expect(groupByIncident([])).toEqual([]);
  });
});
