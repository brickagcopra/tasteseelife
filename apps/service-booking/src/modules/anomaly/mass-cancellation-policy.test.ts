import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HOUSEHOLD_CANCELLATION_THRESHOLD,
  DEFAULT_MASS_CANCELLATION_WINDOW_HOURS,
  DEFAULT_PROVIDER_CANCELLATION_THRESHOLD,
  findMassCancellations,
  massCancellationEventId,
  utcDateBucket,
  type CanceledBookingRow,
} from './mass-cancellation-policy';

/**
 * Unit tests for the mass-cancellation predicate (TS-308c).
 *
 * The load-bearing assertions, in the order they matter:
 *   - **a cancelled recurring series counts ONCE.** The family most
 *     likely to cancel a standing visit is the one whose senior has just
 *     been hospitalised; counting occurrences would make the most
 *     sympathetic case on the platform the one the detector fires on
 *     hardest;
 *   - provider and household are counted INDEPENDENTLY over the same
 *     rows, because they are different subjects with different
 *     responses;
 *   - `distinctActorCount` is what stands in for the role lookup
 *     service-booking is not allowed to make;
 *   - a null actor is UNKNOWN, counted separately, never silently
 *     folded into the actor count;
 *   - a STAFF-initiated cancellation is excluded from every count
 *     (TS-308c-followup-3) — ops closing out a departed provider's
 *     calendar must not read as that provider abandoning their clients
 *     — while a null actor KIND still counts, because it means the row
 *     predates the column rather than that we know it was a customer;
 *   - the bucket is a bare UTC date, which is what stops a rolling
 *     window re-emitting on every tick.
 */

const THRESHOLDS = { provider: 3, household: 3 };

function row(overrides: Partial<CanceledBookingRow> & { bookingId: string }): CanceledBookingRow {
  return {
    providerId: 'prv_1',
    householdId: 'hh_1',
    seriesId: null,
    canceledByUserId: 'usr_1',
    canceledByActorKind: 'customer',
    ...overrides,
  };
}

function rows(count: number, overrides: Partial<CanceledBookingRow> = {}): CanceledBookingRow[] {
  return Array.from({ length: count }, (_unused, index) =>
    row({ bookingId: `bkg_${index}`, ...overrides }),
  );
}

describe('findMassCancellations', () => {
  it('emits nothing below the threshold', () => {
    expect(findMassCancellations(rows(2), THRESHOLDS)).toEqual([]);
  });

  it('emits at exactly the threshold', () => {
    const findings = findMassCancellations(rows(3), THRESHOLDS);
    expect(findings.map((f) => f.subjectKind)).toEqual(['provider', 'household']);
  });

  it('counts a cancelled recurring series as ONE decision', () => {
    // Twelve occurrences of one standing visit, cancelled in a single
    // decision. This is the shape of "our mother went into hospital" and
    // it must not breach a threshold of three.
    const series = rows(12, { seriesId: 'ser_1' });

    expect(findMassCancellations(series, THRESHOLDS)).toEqual([]);
  });

  it('counts occurrences of DIFFERENT series separately', () => {
    const findings = findMassCancellations(
      [
        ...rows(4, { seriesId: 'ser_1' }).map((r, i) => ({ ...r, bookingId: `a_${i}` })),
        ...rows(4, { seriesId: 'ser_2' }).map((r, i) => ({ ...r, bookingId: `b_${i}` })),
        ...rows(4, { seriesId: 'ser_3' }).map((r, i) => ({ ...r, bookingId: `c_${i}` })),
      ],
      THRESHOLDS,
    );

    const provider = findings.find((f) => f.subjectKind === 'provider');
    expect(provider?.distinctCancellationCount).toBe(3);
    // The SIZE of what happened is still reported — twelve visits are
    // twelve visits even when one person decided it.
    expect(provider?.canceledBookingCount).toBe(12);
  });

  it('reports provider and household independently over the same rows', () => {
    // Three cancellations against one provider, spread over three
    // households: the provider breaches, no household does.
    const findings = findMassCancellations(
      [
        row({ bookingId: 'b1', householdId: 'hh_1' }),
        row({ bookingId: 'b2', householdId: 'hh_2' }),
        row({ bookingId: 'b3', householdId: 'hh_3' }),
      ],
      THRESHOLDS,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]?.subjectKind).toBe('provider');
    expect(findings[0]?.subjectId).toBe('prv_1');
  });

  it('separates subjects of the same kind', () => {
    const findings = findMassCancellations(
      [
        ...rows(3, { providerId: 'prv_a' }).map((r, i) => ({ ...r, bookingId: `a_${i}` })),
        ...rows(2, { providerId: 'prv_b' }).map((r, i) => ({ ...r, bookingId: `b_${i}` })),
      ],
      THRESHOLDS,
    );

    const providers = findings.filter((f) => f.subjectKind === 'provider');
    expect(providers.map((f) => f.subjectId)).toEqual(['prv_a']);
  });

  it('carries the threshold that was in force', () => {
    const findings = findMassCancellations(rows(5), { provider: 4, household: 99 });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.threshold).toBe(4);
  });

  it('counts distinct actors — one actor across many cancellations', () => {
    // One person walking away from a day of commitments.
    const findings = findMassCancellations(rows(5, { canceledByUserId: 'usr_solo' }), THRESHOLDS);

    expect(findings[0]?.distinctActorCount).toBe(1);
    expect(findings[0]?.unattributedCount).toBe(0);
  });

  it('counts distinct actors — many families independently cancelling', () => {
    const findings = findMassCancellations(
      Array.from({ length: 5 }, (_unused, i) =>
        row({ bookingId: `b_${i}`, canceledByUserId: `usr_${i}`, householdId: `hh_${i}` }),
      ),
      THRESHOLDS,
    );

    const provider = findings.find((f) => f.subjectKind === 'provider');
    expect(provider?.distinctActorCount).toBe(5);
  });

  it('treats a null actor as UNKNOWN, never as an actor', () => {
    // Every row predates the `canceled_by_user_id` column. Reading
    // "0 actors" as "nobody did this" is the failure mode; the
    // unattributed count is what tells the reviewer the actor number is
    // a floor.
    const findings = findMassCancellations(rows(4, { canceledByUserId: null }), THRESHOLDS);

    expect(findings[0]?.distinctActorCount).toBe(0);
    expect(findings[0]?.unattributedCount).toBe(4);
    expect(findings[0]?.canceledBookingCount).toBe(4);
  });

  it('treats an empty-string actor as unattributed too', () => {
    const findings = findMassCancellations(rows(3, { canceledByUserId: '' }), THRESHOLDS);

    expect(findings[0]?.distinctActorCount).toBe(0);
    expect(findings[0]?.unattributedCount).toBe(3);
  });

  it('returns a stable order — providers then households, each by id', () => {
    const input = [
      ...rows(3, { providerId: 'prv_z', householdId: 'hh_z' }).map((r, i) => ({
        ...r,
        bookingId: `z_${i}`,
      })),
      ...rows(3, { providerId: 'prv_a', householdId: 'hh_a' }).map((r, i) => ({
        ...r,
        bookingId: `a_${i}`,
      })),
    ];

    const first = findMassCancellations(input, THRESHOLDS);
    const second = findMassCancellations([...input].reverse(), THRESHOLDS);

    expect(first.map((f) => `${f.subjectKind}:${f.subjectId}`)).toEqual([
      'provider:prv_a',
      'provider:prv_z',
      'household:hh_a',
      'household:hh_z',
    ]);
    // A detector whose output order varies run to run is one nobody
    // trusts.
    expect(second).toEqual(first);
  });

  it('ignores rows with an empty subject id rather than grouping them together', () => {
    const findings = findMassCancellations(rows(4, { providerId: '' }), THRESHOLDS);

    expect(findings.map((f) => f.subjectKind)).toEqual(['household']);
  });

  it('emits nothing for no rows', () => {
    expect(findMassCancellations([], THRESHOLDS)).toEqual([]);
  });

  // ── TS-308c-followup-3: staff-initiated cancellations ──────────────

  it('OPENS NOTHING when every cancellation was ours', () => {
    // The exact case this exists for: a provider leaves, ops cancels
    // their remaining bookings. One admin acting once, which before this
    // opened a `conduct` incident on somebody who had already gone.
    const findings = findMassCancellations(rows(8, { canceledByActorKind: 'staff' }), THRESHOLDS);

    expect(findings).toEqual([]);
  });

  it('excludes staff rows from the thresholded count', () => {
    const findings = findMassCancellations(
      [
        ...rows(2, { canceledByActorKind: 'customer' }),
        ...rows(6, { canceledByActorKind: 'staff' }).map((r, i) => ({
          ...r,
          bookingId: `bkg_staff_${i}`,
        })),
      ],
      THRESHOLDS,
    );

    // 8 raw rows, threshold 3 — but only 2 were not ours.
    expect(findings).toEqual([]);
  });

  it('still fires when the customer cancellations alone clear the threshold', () => {
    const findings = findMassCancellations(
      [
        ...rows(4, { canceledByActorKind: 'customer' }),
        ...rows(5, { canceledByActorKind: 'staff' }).map((r, i) => ({
          ...r,
          bookingId: `bkg_staff_${i}`,
        })),
      ],
      THRESHOLDS,
    );

    expect(findings[0]?.distinctCancellationCount).toBe(4);
    expect(findings[0]?.canceledBookingCount).toBe(4);
    expect(findings[0]?.staffExcludedCount).toBe(5);
  });

  it('REPORTS the excluded count rather than dropping it', () => {
    // "Four cancellations, and five more by us" and "four cancellations"
    // are different situations. The reviewer must be able to tell them
    // apart, so the number rides the finding even though it counts for
    // nothing.
    const findings = findMassCancellations(
      [
        ...rows(3, { canceledByActorKind: 'customer' }),
        ...rows(2, { canceledByActorKind: 'staff' }).map((r, i) => ({
          ...r,
          bookingId: `bkg_staff_${i}`,
        })),
      ],
      THRESHOLDS,
    );

    expect(findings[0]?.staffExcludedCount).toBe(2);
  });

  it('a NULL actor kind still COUNTS — it means unknown, not customer', () => {
    // Every row cancelled before the column landed is null and cannot be
    // backfilled. Treating unknown as staff would silently stop the
    // detector on historical data; treating it as countable errs toward
    // opening an incident, which is the right direction here.
    const findings = findMassCancellations(rows(4, { canceledByActorKind: null }), THRESHOLDS);

    expect(findings[0]?.distinctCancellationCount).toBe(4);
    expect(findings[0]?.staffExcludedCount).toBe(0);
  });

  it('a staff row does not contribute an actor or an unattributed count either', () => {
    const findings = findMassCancellations(
      [
        ...rows(3, { canceledByActorKind: 'customer', canceledByUserId: 'usr_family' }),
        ...rows(2, { canceledByActorKind: 'staff', canceledByUserId: 'usr_ops' }).map((r, i) => ({
          ...r,
          bookingId: `bkg_staff_${i}`,
        })),
        ...rows(1, { canceledByActorKind: 'staff', canceledByUserId: null }).map((r) => ({
          ...r,
          bookingId: 'bkg_staff_null',
        })),
      ],
      THRESHOLDS,
    );

    expect(findings[0]?.distinctActorCount).toBe(1);
    expect(findings[0]?.unattributedCount).toBe(0);
    expect(findings[0]?.staffExcludedCount).toBe(3);
  });
});

describe('utcDateBucket', () => {
  it('returns a bare UTC date', () => {
    expect(utcDateBucket(new Date('2026-07-26T23:59:59.999Z'))).toBe('2026-07-26');
    expect(utcDateBucket(new Date('2026-07-27T00:00:00.000Z'))).toBe('2026-07-27');
  });

  it('is constant across a day of sweep ticks', () => {
    // This is the property that turns ninety-six ticks into one event.
    const ticks = ['T00:07:00', 'T06:22:00', 'T12:15:00', 'T18:45:00', 'T23:52:00'].map((t) =>
      utcDateBucket(new Date(`2026-07-26${t}.000Z`)),
    );

    expect(new Set(ticks).size).toBe(1);
  });
});

describe('massCancellationEventId', () => {
  it('is deterministic per subject per day', () => {
    expect(massCancellationEventId('provider', 'prv_1', '2026-07-26')).toBe(
      'mass-cancellation:provider:prv_1:2026-07-26',
    );
  });

  it('differs by subject kind, by subject, and by day', () => {
    const ids = new Set([
      massCancellationEventId('provider', 'x', '2026-07-26'),
      massCancellationEventId('household', 'x', '2026-07-26'),
      massCancellationEventId('provider', 'y', '2026-07-26'),
      massCancellationEventId('provider', 'x', '2026-07-27'),
    ]);

    expect(ids.size).toBe(4);
  });
});

describe('defaults', () => {
  it('sets the household threshold ABOVE the provider one', () => {
    // Deliberate and counter-intuitive: households book fewer visits,
    // but the dominant benign explanation for a household breach is a
    // family in crisis cancelling everything at once.
    expect(DEFAULT_HOUSEHOLD_CANCELLATION_THRESHOLD).toBeGreaterThan(
      DEFAULT_PROVIDER_CANCELLATION_THRESHOLD,
    );
  });

  it('keeps the window at a day — the unit the behaviour happens in', () => {
    expect(DEFAULT_MASS_CANCELLATION_WINDOW_HOURS).toBe(24);
  });
});
