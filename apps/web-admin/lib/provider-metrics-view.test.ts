import type { ProviderMetricsWindow } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import {
  formatMetricRate,
  formatResponseTime,
  lifetimeScopeLabel,
  metricsWindowHeadline,
} from './provider-metrics-view';

/**
 * TS-305d — what a review committee actually reads off the performance
 * panel.
 *
 * The properties under test are the ones that would mislead a reader
 * rather than merely look untidy: that "nothing on record" and "too
 * little to score" are different sentences, that neither is ever
 * rendered as a zero, and that a response time is never given a
 * precision the measurement does not have.
 */

const COUNTS = {
  bookingsOffered: 9,
  bookingsAccepted: 7,
  bookingsDeclined: 1,
  bookingsExpiredUnanswered: 1,
  bookingsDeclinedByAdmin: 0,
  bookingsCompleted: 6,
  bookingsCanceledAfterAcceptance: 1,
  decidedBookings: 7,
} as const;

describe('formatMetricRate', () => {
  it('renders tenths of a percent at the precision they were computed', () => {
    expect(formatMetricRate(952)).toBe('95.2%');
    expect(formatMetricRate(1000)).toBe('100.0%');
    expect(formatMetricRate(0)).toBe('0.0%');
  });
});

describe('formatResponseTime', () => {
  it('says so plainly when there is nothing to average, rather than showing a zero', () => {
    expect(formatResponseTime(null)).toBe('Not enough answered requests to say');
  });

  it('keeps seconds under a minute, where the difference between 5 and 50 is real', () => {
    expect(formatResponseTime(5)).toBe('about 5 seconds');
    expect(formatResponseTime(1)).toBe('about 1 second');
  });

  it('steps up to minutes, then hours, then days as the number grows', () => {
    expect(formatResponseTime(1800)).toBe('about 30 minutes');
    expect(formatResponseTime(7200)).toBe('about 2 hours');
    expect(formatResponseTime(180_000)).toBe('about 2 days');
  });

  it('never renders a false precision like "1.83 hours"', () => {
    expect(formatResponseTime(6600)).not.toContain('.');
  });

  it('singularises', () => {
    expect(formatResponseTime(86_400)).toBe('about 24 hours');
    expect(formatResponseTime(129_600)).toBe('about 2 days');
  });
});

describe('metricsWindowHeadline', () => {
  it('no_activity says there is nothing to score, NOT that the score is low', () => {
    const headline = metricsWindowHeadline({ state: 'no_activity' }, 90);
    expect(headline).toContain('No bookings on record');
    expect(headline).toContain('not a low score');
    expect(headline).not.toContain('0%');
  });

  it('insufficient_data is a DIFFERENT sentence — a new provider must not read as a dormant one', () => {
    const window: ProviderMetricsWindow = {
      state: 'insufficient_data',
      counts: { ...COUNTS, decidedBookings: 2 },
      minimumDecidedBookings: 5,
    };
    const headline = metricsWindowHeadline(window, 90);
    expect(headline).toContain('2 bookings');
    expect(headline).toContain('fewer than the 5');
    expect(headline).toContain('rates are deliberately not shown');
    expect(headline).not.toEqual(metricsWindowHeadline({ state: 'no_activity' }, 90));
  });

  it('never renders a percentage on a window that has none', () => {
    for (const window of [
      { state: 'no_activity' } as const,
      {
        state: 'insufficient_data',
        counts: COUNTS,
        minimumDecidedBookings: 5,
      } as ProviderMetricsWindow,
    ]) {
      expect(metricsWindowHeadline(window, 90)).not.toContain('%');
    }
  });

  it('measured states its denominator, so the rate beside it can be checked', () => {
    const window: ProviderMetricsWindow = {
      state: 'measured',
      counts: COUNTS,
      completionRate: 857,
      cancellationRate: 143,
      acceptanceRate: 778,
      medianResponseSeconds: 1800,
    };
    expect(metricsWindowHeadline(window, 90)).toContain('7 finished bookings');
  });

  it('names the window it describes rather than leaving a reader to assume one', () => {
    expect(metricsWindowHeadline({ state: 'no_activity' }, 90)).toContain('last 90 days');
    expect(metricsWindowHeadline({ state: 'no_activity' }, 0)).toContain('whole record');
  });

  it('singularises a one-booking count', () => {
    const window: ProviderMetricsWindow = {
      state: 'insufficient_data',
      counts: { ...COUNTS, decidedBookings: 1 },
      minimumDecidedBookings: 5,
    };
    expect(metricsWindowHeadline(window, 90)).toContain('1 booking finished');
  });
});

describe('lifetimeScopeLabel', () => {
  const now = new Date('2026-08-06T12:00:00.000Z');

  it('puts the span of the record in the label — three weeks and three years wear the same word otherwise', () => {
    expect(lifetimeScopeLabel('2026-07-27T12:00:00.000Z', now)).toBe(
      'All time (10 days of record)',
    );
    expect(lifetimeScopeLabel('2025-08-06T12:00:00.000Z', now)).toBe(
      'All time (12 months of record)',
    );
    expect(lifetimeScopeLabel('2022-01-01T12:00:00.000Z', now)).toBe(
      'All time (4+ years of record)',
    );
  });

  it('falls back to a bare label when nothing has been observed', () => {
    expect(lifetimeScopeLabel(null, now)).toBe('All time');
  });

  it('does not throw on an unparseable timestamp — a broken date must not 500 a reviewer out of the page', () => {
    expect(lifetimeScopeLabel('not-a-date', now)).toBe('All time');
  });
});
