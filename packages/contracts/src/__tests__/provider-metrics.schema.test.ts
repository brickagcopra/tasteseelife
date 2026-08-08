import { describe, expect, it } from 'vitest';

import {
  PROVIDER_METRICS_MIN_SAMPLE,
  PROVIDER_METRICS_WINDOW_DAYS,
  ProviderMetricsRateSchema,
  ProviderMetricsSectionSchema,
  ProviderMetricsWindowSchema,
} from '../http/provider-metrics.schema';

/**
 * TS-305d — the provider metrics contract.
 *
 * What this file pins is not field presence but the four disclosure and
 * honesty properties the schema exists to enforce, each of which a
 * future widening could quietly undo:
 *
 *   1. "no number" is three distinguishable outcomes, not one;
 *   2. a rate can never be stated without its counts;
 *   3. the window travels with the figures;
 *   4. there is still no rating anywhere on this surface.
 */

const COUNTS = {
  bookingsOffered: 20,
  bookingsAccepted: 14,
  bookingsDeclined: 4,
  bookingsExpiredUnanswered: 2,
  bookingsDeclinedByAdmin: 0,
  bookingsCompleted: 9,
  bookingsCanceledAfterAcceptance: 1,
  decidedBookings: 10,
} as const;

const MEASURED = {
  state: 'measured',
  counts: COUNTS,
  completionRate: 900,
  cancellationRate: 100,
  acceptanceRate: 700,
  medianResponseSeconds: 1800,
} as const;

const SECTION = {
  lifetime: MEASURED,
  recent: { state: 'no_activity' },
  windowDays: PROVIDER_METRICS_WINDOW_DAYS,
  firstObservedAt: '2025-11-02T09:00:00.000Z',
  lastObservedAt: '2026-07-30T18:00:00.000Z',
  computedAt: '2026-08-06T12:00:00.000Z',
} as const;

describe('ProviderMetricsWindowSchema — the three states', () => {
  it('accepts a measured window', () => {
    expect(ProviderMetricsWindowSchema.safeParse(MEASURED).success).toBe(true);
  });

  it('accepts no_activity, which carries NOTHING — a zero count would be a claim about a provider we have never seen', () => {
    const parsed = ProviderMetricsWindowSchema.safeParse({ state: 'no_activity' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({ state: 'no_activity' });
  });

  it('rejects a no_activity window that smuggles counts in', () => {
    expect(
      ProviderMetricsWindowSchema.safeParse({ state: 'no_activity', counts: COUNTS }).success,
    ).toBe(false);
  });

  it('accepts insufficient_data WITH its counts — a reviewer may see "two bookings, both completed"', () => {
    expect(
      ProviderMetricsWindowSchema.safeParse({
        state: 'insufficient_data',
        counts: { ...COUNTS, decidedBookings: 2 },
        minimumDecidedBookings: PROVIDER_METRICS_MIN_SAMPLE,
      }).success,
    ).toBe(true);
  });

  it('REJECTS a rate on an insufficient_data window — the whole point of the state is that the percentage is not stateable', () => {
    expect(
      ProviderMetricsWindowSchema.safeParse({
        state: 'insufficient_data',
        counts: COUNTS,
        minimumDecidedBookings: 5,
        completionRate: 1000,
      }).success,
    ).toBe(false);
  });

  it('REJECTS a measured window with no counts — a rate nobody can check is a rate nobody can argue with', () => {
    const { counts: _dropped, ...withoutCounts } = MEASURED;
    expect(ProviderMetricsWindowSchema.safeParse(withoutCounts).success).toBe(false);
  });

  it('allows a null median — some providers have no booking with both instants on record', () => {
    expect(
      ProviderMetricsWindowSchema.safeParse({ ...MEASURED, medianResponseSeconds: null }).success,
    ).toBe(true);
  });

  it('rejects an unknown state rather than defaulting to one', () => {
    expect(ProviderMetricsWindowSchema.safeParse({ state: 'unknown' }).success).toBe(false);
  });
});

describe('ProviderMetricsCountsSchema — the names refuse attribution the platform cannot establish', () => {
  it.each([
    'cancellationsCaused',
    'cancellationsByProvider',
    'providerFaultCancellations',
    'canceledByUserId',
  ])('rejects %s — service-provider cannot resolve who cancelled a booking (§2.3)', (field) => {
    expect(
      ProviderMetricsWindowSchema.safeParse({
        ...MEASURED,
        counts: { ...COUNTS, [field]: 1 },
      }).success,
    ).toBe(false);
  });

  it('keeps silence and refusal apart — an expired offer is not a decline', () => {
    const parsed = ProviderMetricsWindowSchema.safeParse(MEASURED);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.state !== 'measured') throw new Error('unreachable');
    expect(parsed.data.counts.bookingsDeclined).toBe(4);
    expect(parsed.data.counts.bookingsExpiredUnanswered).toBe(2);
  });
});

describe('ProviderMetricsRateSchema', () => {
  it('is integer tenths of a percent, so two surfaces cannot render the same rate differently', () => {
    expect(ProviderMetricsRateSchema.safeParse(952).success).toBe(true);
    expect(ProviderMetricsRateSchema.safeParse(95.2).success).toBe(false);
  });

  it('is bounded at 0 and 1000', () => {
    expect(ProviderMetricsRateSchema.safeParse(-1).success).toBe(false);
    expect(ProviderMetricsRateSchema.safeParse(1001).success).toBe(false);
  });
});

describe('ProviderMetricsSectionSchema', () => {
  it('accepts the composed section', () => {
    expect(ProviderMetricsSectionSchema.safeParse(SECTION).success).toBe(true);
  });

  it('REQUIRES windowDays — a rolling figure whose window a consumer has to assume is a figure two people read differently', () => {
    const { windowDays: _dropped, ...withoutWindow } = SECTION;
    expect(ProviderMetricsSectionSchema.safeParse(withoutWindow).success).toBe(false);
  });

  it('REQUIRES both windows — neither is derivable from the other', () => {
    const { recent: _r, ...withoutRecent } = SECTION;
    expect(ProviderMetricsSectionSchema.safeParse(withoutRecent).success).toBe(false);
    const { lifetime: _l, ...withoutLifetime } = SECTION;
    expect(ProviderMetricsSectionSchema.safeParse(withoutLifetime).success).toBe(false);
  });

  it('REQUIRES firstObservedAt — a lifetime rate over three weeks and one over three years wear the same label', () => {
    const { firstObservedAt: _dropped, ...without } = SECTION;
    expect(ProviderMetricsSectionSchema.safeParse(without).success).toBe(false);
    expect(
      ProviderMetricsSectionSchema.safeParse({ ...SECTION, firstObservedAt: null }).success,
    ).toBe(true);
  });

  it.each(['rating', 'ratingAvg', 'ratingCount', 'reviews'])(
    'REJECTS %s — nothing on this platform captures a rating, and a field here would read as "this provider has none" (TS-305e)',
    (field) => {
      expect(ProviderMetricsSectionSchema.safeParse({ ...SECTION, [field]: 4.5 }).success).toBe(
        false,
      );
    },
  );

  it.each(['bookingId', 'householdId', 'seniorId', 'earningsMinor'])(
    'REJECTS %s — this is an aggregate, and a per-booking or per-family detail has no business on it',
    (field) => {
      expect(ProviderMetricsSectionSchema.safeParse({ ...SECTION, [field]: 'x' }).success).toBe(
        false,
      );
    },
  );
});

describe('the unconfirmed constants are stated once, here', () => {
  it('exports the window and the sample floor so a surface never hard-codes them into copy', () => {
    expect(PROVIDER_METRICS_WINDOW_DAYS).toBe(90);
    expect(PROVIDER_METRICS_MIN_SAMPLE).toBe(5);
  });
});
