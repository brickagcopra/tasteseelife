import { describe, expect, it } from 'vitest';

import { describeSystemEvidence, detectorLabel } from './system-evidence';

/**
 * Unit tests for the system-evidence labelling (TS-308c-followup-2).
 *
 * These strings are the ONLY explanation an operator gets for a
 * system-opened incident — every one of them has a null `description` by
 * design. So the properties worth asserting are about what the wording
 * commits to:
 *   - a measurement is always shown against the threshold that was in
 *     force, because a speed or a count means nothing on its own;
 *   - the actor count is presented as a FLOOR whenever some rows carry no
 *     recorded actor, because a bare "1" invites a conclusion the data does
 *     not support;
 *   - the visits-affected number stays separate from the decision count,
 *     because the gap between them is usually the whole explanation;
 *   - nothing in the output is a verdict.
 */

describe('detectorLabel', () => {
  it('names each detector', () => {
    expect(detectorLabel('background_check')).toBe('Background-check monitoring');
    expect(detectorLabel('impossible_travel')).toBe('Impossible-travel detection');
    expect(detectorLabel('mass_cancellation')).toBe('Mass-cancellation detection');
  });

  it('returns null when there is no detector', () => {
    expect(detectorLabel(null)).toBeNull();
  });
});

describe('describeSystemEvidence — impossible travel', () => {
  const evidence = {
    detector: 'impossible_travel',
    previousCheckInId: 'ci_1',
    checkInId: 'ci_2',
    previousBookingId: 'bkg_1',
    bookingId: 'bkg_2',
    distanceMeters: 812_000,
    elapsedSeconds: 3_900,
    impliedSpeedKph: 749.5,
    thresholdKph: 1_000,
    previousOccurredAt: '2026-07-25T09:00:00.000Z',
    occurredAt: '2026-07-25T10:05:00.000Z',
  } as const;

  it('always shows the speed against the ceiling in force', () => {
    // The threshold may have been retuned since; the number that opened
    // the incident is the one that explains it.
    const view = describeSystemEvidence(evidence);
    const speed = view.rows.find((row) => row.label === 'Implied speed');

    expect(speed?.value).toBe('749.5 km/h (ceiling 1000 km/h)');
  });

  it('states the distance and interval without drawing a conclusion', () => {
    const view = describeSystemEvidence(evidence);

    expect(view.headline).toBe('Two check-ins 812 km apart, 1h 5m apart in time.');
    expect(view.headline).not.toMatch(/fake|spoof|fraud|lied/i);
  });

  it('marks the ids as ids so they render as handles', () => {
    const view = describeSystemEvidence(evidence);
    const ids = view.rows.filter((row) => row.isId === true).map((row) => row.value);

    expect(ids).toEqual(['ci_1', 'ci_2', 'bkg_1', 'bkg_2']);
  });

  it('carries no coordinates — there are none to carry', () => {
    const serialised = JSON.stringify(describeSystemEvidence(evidence));

    expect(serialised).not.toContain('latitude');
    expect(serialised).not.toContain('longitude');
  });

  it('formats sub-kilometre distances in metres', () => {
    const view = describeSystemEvidence({ ...evidence, distanceMeters: 640 });

    expect(view.headline).toContain('640 m');
  });
});

describe('describeSystemEvidence — mass cancellation', () => {
  const evidence = {
    detector: 'mass_cancellation',
    subjectKind: 'provider',
    windowStart: '2026-07-25T18:00:00.000Z',
    windowEnd: '2026-07-26T18:00:00.000Z',
    canceledBookingCount: 9,
    distinctCancellationCount: 6,
    threshold: 5,
    distinctActorCount: 1,
    unattributedCount: 0,
    staffExcludedCount: 0,
  } as const;

  it('keeps decisions and visits as SEPARATE numbers', () => {
    // A cancelled recurring series is one decision covering many visits.
    // Collapsing the two would hide the most common explanation.
    const view = describeSystemEvidence(evidence);

    expect(view.rows.find((row) => row.label === 'Cancellation decisions')?.value).toBe(
      '6 (threshold 5)',
    );
    expect(view.rows.find((row) => row.label === 'Visits affected')?.value).toBe('9');
  });

  it('presents the actor count as a FLOOR when some rows have no actor', () => {
    const view = describeSystemEvidence({
      ...evidence,
      distinctActorCount: 1,
      unattributedCount: 4,
    });

    const actors = view.rows.find((row) => row.label === 'Distinct people cancelling');
    expect(actors?.value).toContain('minimum');
    expect(actors?.value).toContain('4 with no recorded actor');
  });

  it('states the count plainly when every row carries an actor', () => {
    const view = describeSystemEvidence(evidence);

    expect(view.rows.find((row) => row.label === 'Distinct people cancelling')?.value).toBe('1');
  });

  it('names the subject kind and never asserts wrongdoing', () => {
    const household = describeSystemEvidence({ ...evidence, subjectKind: 'household' });

    expect(household.headline).toContain('household');
    expect(household.headline).not.toMatch(/abuse|gaming|fraud|exploit/i);
  });

  it('singularises a one-visit finding', () => {
    const view = describeSystemEvidence({
      ...evidence,
      canceledBookingCount: 1,
      distinctCancellationCount: 1,
    });

    expect(view.headline).toContain('1 visit.');
  });

  it('OMITS the staff-excluded row when there is nothing to exclude', () => {
    // "0 cancelled by our own team" on every incident is noise that
    // trains an operator to skip the panel.
    const view = describeSystemEvidence(evidence);

    expect(view.rows.some((row) => row.label.startsWith('Excluded'))).toBe(false);
  });

  it('states the staff-excluded count when there is one, as an exclusion', () => {
    // The ops-bulk-cancel case. The number is deliberately labelled as
    // NOT counted above, so a reviewer reading "6 decisions" beside "8
    // more by our team" cannot add them together.
    const view = describeSystemEvidence({ ...evidence, staffExcludedCount: 8 });
    const row = view.rows.find((r) => r.label.startsWith('Excluded'));

    expect(row?.value).toContain('8');
    expect(row?.value).toContain('not counted above');
  });

  it('singularises a single excluded visit', () => {
    const view = describeSystemEvidence({ ...evidence, staffExcludedCount: 1 });

    expect(view.rows.find((r) => r.label.startsWith('Excluded'))?.value).toContain(
      '1 more visit was',
    );
  });
});

describe('describeSystemEvidence — background check', () => {
  const evidence = {
    detector: 'background_check',
    backgroundCheckId: 'bgc_1',
    status: 'consider',
    previousStatus: 'clear',
  } as const;

  it('reports the categorical status, never a finding', () => {
    const view = describeSystemEvidence(evidence);

    expect(view.headline).toBe('A background check on this provider returned "consider".');
    expect(view.rows.find((row) => row.label === 'Current status')?.value).toBe('consider');
    expect(view.rows.find((row) => row.label === 'Previous status')?.value).toBe('clear');
  });

  it('says so when there is no previous status', () => {
    const view = describeSystemEvidence({ ...evidence, previousStatus: null });

    expect(view.rows.find((row) => row.label === 'Previous status')?.value).toBe('none recorded');
  });
});
