import {
  PROVIDER_METRICS_MIN_SAMPLE,
  PROVIDER_METRICS_WINDOW_DAYS,
} from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import {
  computeMetricsSection,
  computeWindow,
  countFacts,
  isWithinWindow,
  medianOf,
  responseGapSeconds,
  toRate,
  type BookingFactSummary,
} from './metrics-computation';

/**
 * TS-305d — the arithmetic and the judgements behind the provider
 * metrics section.
 *
 * The properties under test are the ones that turn a measurement into
 * an accusation if they are wrong: what counts as a decided booking,
 * which declines are the provider's, whether a two-booking provider
 * gets a percentage at all, and which bookings are eligible for a
 * response-time median.
 */

const NOW = new Date('2026-08-06T12:00:00.000Z');

function fact(overrides: Partial<BookingFactSummary> = {}): BookingFactSummary {
  return {
    offeredAt: new Date('2026-08-01T09:00:00.000Z'),
    respondedAt: null,
    responseKind: null,
    declineKind: null,
    outcome: null,
    outcomeAt: null,
    ...overrides,
  };
}

function accepted(overrides: Partial<BookingFactSummary> = {}): BookingFactSummary {
  return fact({
    respondedAt: new Date('2026-08-01T09:30:00.000Z'),
    responseKind: 'accepted',
    ...overrides,
  });
}

function completed(overrides: Partial<BookingFactSummary> = {}): BookingFactSummary {
  return accepted({
    outcome: 'completed',
    outcomeAt: new Date('2026-08-03T12:00:00.000Z'),
    ...overrides,
  });
}

describe('toRate', () => {
  it('returns integer tenths of a percent', () => {
    expect(toRate(1, 2)).toBe(500);
    expect(toRate(19, 20)).toBe(950);
    expect(toRate(2, 3)).toBe(667);
  });

  it('returns 0 for a zero denominator rather than NaN — the state discrimination is what stops callers reaching here', () => {
    expect(toRate(0, 0)).toBe(0);
    expect(toRate(3, 0)).toBe(0);
  });

  it('clamps into 0..1000', () => {
    expect(toRate(3, 2)).toBe(1000);
    expect(toRate(-1, 2)).toBe(0);
  });
});

describe('countFacts — the decided-bookings denominator', () => {
  it('excludes an accepted booking that has not finished — it is neither a success nor a failure', () => {
    const counts = countFacts([accepted(), accepted()]);
    expect(counts.bookingsAccepted).toBe(2);
    expect(counts.decidedBookings).toBe(0);
  });

  it('excludes declined and expired offers — a provider who declines work they cannot cover is not unreliable', () => {
    const counts = countFacts([
      fact({
        respondedAt: NOW,
        responseKind: 'declined',
        declineKind: 'provider_declined',
        outcome: 'declined',
        outcomeAt: NOW,
      }),
      fact({
        respondedAt: NOW,
        responseKind: 'declined',
        declineKind: 'window_expired',
        outcome: 'declined',
        outcomeAt: NOW,
      }),
    ]);
    expect(counts.bookingsDeclined).toBe(1);
    expect(counts.bookingsExpiredUnanswered).toBe(1);
    expect(counts.decidedBookings).toBe(0);
  });

  it('excludes a booking cancelled out of pending — there was no commitment to break', () => {
    const counts = countFacts([
      fact({ outcome: 'canceled', outcomeAt: NOW, cancellationReason: 'family_request' } as never),
    ]);
    expect(counts.bookingsCanceledAfterAcceptance).toBe(0);
    expect(counts.decidedBookings).toBe(0);
  });

  it('counts a cancellation only once the provider had accepted', () => {
    const counts = countFacts([accepted({ outcome: 'canceled', outcomeAt: NOW })]);
    expect(counts.bookingsCanceledAfterAcceptance).toBe(1);
    expect(counts.decidedBookings).toBe(1);
  });

  it('separates the three kinds of decline — silence, refusal and an ops decision are different behaviours', () => {
    const counts = countFacts([
      fact({ respondedAt: NOW, responseKind: 'declined', declineKind: 'provider_declined' }),
      fact({ respondedAt: NOW, responseKind: 'declined', declineKind: 'window_expired' }),
      fact({ respondedAt: NOW, responseKind: 'declined', declineKind: 'admin_declined' }),
    ]);
    expect(counts.bookingsDeclined).toBe(1);
    expect(counts.bookingsExpiredUnanswered).toBe(1);
    expect(counts.bookingsDeclinedByAdmin).toBe(1);
  });

  it('does not count a fact with no known offer instant as an offer', () => {
    expect(countFacts([fact({ offeredAt: null })]).bookingsOffered).toBe(0);
  });
});

describe('computeWindow — the three-way state', () => {
  it('reports no_activity for an empty set, not a zero rate', () => {
    expect(computeWindow([])).toEqual({ state: 'no_activity' });
  });

  it('refuses to state a rate below the sample floor, but still reports the counts', () => {
    const window = computeWindow([completed()]);
    expect(window.state).toBe('insufficient_data');
    if (window.state !== 'insufficient_data') throw new Error('unreachable');
    expect(window.counts.bookingsCompleted).toBe(1);
    expect(window.minimumDecidedBookings).toBe(PROVIDER_METRICS_MIN_SAMPLE);
    expect(window).not.toHaveProperty('completionRate');
  });

  it('one cancelled booking is one cancellation, NOT a 100% cancellation rate', () => {
    const window = computeWindow([accepted({ outcome: 'canceled', outcomeAt: NOW })]);
    expect(window.state).toBe('insufficient_data');
  });

  it('states rates once the floor is met', () => {
    const facts = [
      ...Array.from({ length: 4 }, () => completed()),
      accepted({ outcome: 'canceled', outcomeAt: NOW }),
    ];
    const window = computeWindow(facts);
    expect(window.state).toBe('measured');
    if (window.state !== 'measured') throw new Error('unreachable');
    expect(window.counts.decidedBookings).toBe(5);
    expect(window.completionRate).toBe(800);
    expect(window.cancellationRate).toBe(200);
  });

  it('the floor is on DECIDED bookings — twenty unanswered offers do not cross it', () => {
    const window = computeWindow(Array.from({ length: 20 }, () => fact()));
    expect(window.state).toBe('insufficient_data');
    if (window.state !== 'insufficient_data') throw new Error('unreachable');
    expect(window.counts.bookingsOffered).toBe(20);
  });

  it('excludes admin declines from BOTH sides of the acceptance rate', () => {
    // 4 accepted + 1 declined by the provider = 80%. Two admin declines
    // must not appear in the denominator, or ops decisions would depress
    // the provider's own rate.
    const facts = [
      ...Array.from({ length: 4 }, () => completed()),
      fact({ respondedAt: NOW, responseKind: 'declined', declineKind: 'provider_declined' }),
      fact({ respondedAt: NOW, responseKind: 'declined', declineKind: 'admin_declined' }),
      fact({ respondedAt: NOW, responseKind: 'declined', declineKind: 'admin_declined' }),
      accepted({ outcome: 'canceled', outcomeAt: NOW }),
    ];
    const window = computeWindow(facts);
    if (window.state !== 'measured') throw new Error('expected measured');
    expect(window.counts.bookingsDeclinedByAdmin).toBe(2);
    expect(window.acceptanceRate).toBe(833); // 5 accepted / 6 answerable
  });
});

describe('responseGapSeconds', () => {
  it('measures offer to response in whole seconds', () => {
    expect(
      responseGapSeconds([
        fact({
          offeredAt: new Date('2026-08-01T09:00:00.000Z'),
          respondedAt: new Date('2026-08-01T09:30:00.000Z'),
          responseKind: 'accepted',
        }),
      ]),
    ).toEqual([1800]);
  });

  it('EXCLUDES an expired offer — nobody responded, and including it would report the accept window as the provider speed', () => {
    expect(
      responseGapSeconds([
        fact({
          offeredAt: new Date('2026-08-01T09:00:00.000Z'),
          respondedAt: new Date('2026-08-01T09:30:00.000Z'),
          responseKind: 'declined',
          declineKind: 'window_expired',
        }),
      ]),
    ).toEqual([]);
  });

  it('includes an explicit decline — refusing quickly is still responding quickly', () => {
    expect(
      responseGapSeconds([
        fact({
          offeredAt: new Date('2026-08-01T09:00:00.000Z'),
          respondedAt: new Date('2026-08-01T09:01:00.000Z'),
          responseKind: 'declined',
          declineKind: 'provider_declined',
        }),
      ]),
    ).toEqual([60]);
  });

  it('drops a negative gap rather than clamping it to zero — a zero would claim somebody answered instantly', () => {
    expect(
      responseGapSeconds([
        fact({
          offeredAt: new Date('2026-08-01T09:00:00.000Z'),
          respondedAt: new Date('2026-08-01T08:00:00.000Z'),
          responseKind: 'accepted',
        }),
      ]),
    ).toEqual([]);
  });

  it('skips a booking missing either instant', () => {
    expect(
      responseGapSeconds([
        fact({ offeredAt: null, respondedAt: NOW }),
        accepted({ offeredAt: null }),
      ]),
    ).toEqual([]);
  });
});

describe('medianOf', () => {
  it('returns null for an empty sample', () => {
    expect(medianOf([])).toBeNull();
  });

  it('returns the middle observed value for an odd sample', () => {
    expect(medianOf([10, 300, 20])).toBe(20);
  });

  it('takes the LOWER middle value for an even sample rather than averaging two', () => {
    expect(medianOf([10, 20, 30, 40])).toBe(20);
  });

  it('is not dragged by one outlier the way a mean would be', () => {
    const sample = [60, 90, 120, 150, 1_209_600]; // one fortnight-long reply
    expect(medianOf(sample)).toBe(120);
  });
});

describe('isWithinWindow', () => {
  const cutoff = new Date('2026-05-08T12:00:00.000Z');

  it('includes a booking offered on or after the cutoff', () => {
    expect(isWithinWindow(fact({ offeredAt: cutoff }), cutoff)).toBe(true);
  });

  it('excludes one offered before it', () => {
    expect(isWithinWindow(fact({ offeredAt: new Date('2026-05-08T11:59:59.000Z') }), cutoff)).toBe(
      false,
    );
  });

  it('excludes a fact with no known offer instant — the recent window is a cohort of REQUESTS', () => {
    expect(isWithinWindow(fact({ offeredAt: null, outcomeAt: NOW }), cutoff)).toBe(false);
  });
});

describe('computeMetricsSection', () => {
  it('carries the window it used rather than leaving a consumer to assume one', () => {
    expect(computeMetricsSection([], NOW).windowDays).toBe(PROVIDER_METRICS_WINDOW_DAYS);
  });

  it('reports no_activity on both windows and null observation bounds when nothing is known', () => {
    const section = computeMetricsSection([], NOW);
    expect(section.lifetime).toEqual({ state: 'no_activity' });
    expect(section.recent).toEqual({ state: 'no_activity' });
    expect(section.firstObservedAt).toBeNull();
    expect(section.lastObservedAt).toBeNull();
  });

  it('a provider with only OLD history is measured for lifetime and no_activity for recent — the two must not be conflated', () => {
    const oldDay = new Date('2025-01-10T09:00:00.000Z');
    const facts = Array.from({ length: 6 }, () =>
      completed({ offeredAt: oldDay, respondedAt: oldDay, outcomeAt: oldDay }),
    );
    const section = computeMetricsSection(facts, NOW);
    expect(section.lifetime.state).toBe('measured');
    expect(section.recent.state).toBe('no_activity');
  });

  it('firstObservedAt spans every instant kind, so an outcome-only fact still bounds the record', () => {
    const section = computeMetricsSection(
      [
        fact({
          offeredAt: null,
          outcome: 'completed',
          outcomeAt: new Date('2024-03-02T00:00:00.000Z'),
        }),
      ],
      NOW,
    );
    expect(section.firstObservedAt).toBe('2024-03-02T00:00:00.000Z');
    expect(section.lastObservedAt).toBe('2024-03-02T00:00:00.000Z');
  });

  it('stamps computedAt from the injected clock, so every section of one dossier describes one instant', () => {
    expect(computeMetricsSection([], NOW).computedAt).toBe(NOW.toISOString());
  });
});
