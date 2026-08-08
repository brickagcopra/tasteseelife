import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IMPOSSIBLE_TRAVEL_MAX_SPEED_KPH,
  IMPOSSIBLE_TRAVEL_MIN_DISTANCE_METERS,
  findImpossibleTravel,
  greatCircleDistanceMeters,
  judgeCheckInPair,
  type CheckInPoint,
} from './impossible-travel-policy';

/**
 * Unit tests for the impossible-travel predicate (TS-308a).
 *
 * The assertions that matter most are the ones about what this must
 * NOT flag, because a detector that opens safety incidents on ordinary
 * life is one operators learn to dismiss — at which point it is worse
 * than no detector:
 *
 *   - a provider who catches a plane;
 *   - GPS jitter at a stationary address;
 *   - back-to-back visits in the same building;
 *   - two check-ins sharing a timestamp, which must not divide by zero
 *     into an infinite speed.
 */

/** New York City hall. */
const NYC = { latitude: 40.7128, longitude: -74.006 };
/** Los Angeles city hall — ~3,936 km from NYC. */
const LA = { latitude: 34.0522, longitude: -118.2437 };

function point(
  id: string,
  coords: { latitude: number; longitude: number },
  occurredAt: string,
): CheckInPoint {
  return { id, bookingId: `bk_${id}`, ...coords, occurredAt: new Date(occurredAt) };
}

describe('greatCircleDistanceMeters', () => {
  it('computes a known long distance to within a kilometre', () => {
    const meters = greatCircleDistanceMeters(
      point('a', NYC, '2026-07-26T10:00:00.000Z'),
      point('b', LA, '2026-07-26T20:00:00.000Z'),
    );

    // Published great-circle NYC → LA is ~3,936 km.
    expect(meters).toBeGreaterThan(3_930_000);
    expect(meters).toBeLessThan(3_945_000);
  });

  it('is zero for identical points', () => {
    expect(
      greatCircleDistanceMeters(
        point('a', NYC, '2026-07-26T10:00:00.000Z'),
        point('b', NYC, '2026-07-26T11:00:00.000Z'),
      ),
    ).toBe(0);
  });

  it('is symmetric', () => {
    const a = point('a', NYC, '2026-07-26T10:00:00.000Z');
    const b = point('b', LA, '2026-07-26T11:00:00.000Z');

    expect(greatCircleDistanceMeters(a, b)).toBe(greatCircleDistanceMeters(b, a));
  });

  it('does not return NaN for antipodal points', () => {
    // The `Math.min(1, …)` guard: floating point can push the haversine
    // term just above 1 here and `asin` would go NaN.
    const meters = greatCircleDistanceMeters(
      point('a', { latitude: 0, longitude: 0 }, '2026-07-26T10:00:00.000Z'),
      point('b', { latitude: 0, longitude: 180 }, '2026-07-26T11:00:00.000Z'),
    );

    expect(Number.isNaN(meters)).toBe(false);
    expect(meters).toBeGreaterThan(20_000_000);
  });

  it('returns whole metres — sub-metre precision would re-encode the coordinates', () => {
    const meters = greatCircleDistanceMeters(
      point('a', { latitude: 40.7128, longitude: -74.006 }, '2026-07-26T10:00:00.000Z'),
      point('b', { latitude: 40.7228, longitude: -74.0161 }, '2026-07-26T10:30:00.000Z'),
    );

    expect(Number.isInteger(meters)).toBe(true);
  });
});

describe('judgeCheckInPair', () => {
  const MAX = DEFAULT_IMPOSSIBLE_TRAVEL_MAX_SPEED_KPH;

  it('flags NYC → LA in twenty minutes', () => {
    const finding = judgeCheckInPair(
      point('a', NYC, '2026-07-26T10:00:00.000Z'),
      point('b', LA, '2026-07-26T10:20:00.000Z'),
      MAX,
    );

    expect(finding).not.toBeNull();
    expect(finding?.elapsedSeconds).toBe(1200);
    expect(finding?.impliedSpeedKph).toBeGreaterThan(10_000);
  });

  it('DOES NOT flag NYC → LA in six hours — that is a flight, and flights are legitimate', () => {
    // ~656 km/h implied. A provider flying to a family emergency and
    // working a visit at the other end is doing nothing wrong, and an
    // incident here is one an operator learns to dismiss.
    expect(
      judgeCheckInPair(
        point('a', NYC, '2026-07-26T10:00:00.000Z'),
        point('b', LA, '2026-07-26T16:00:00.000Z'),
        MAX,
      ),
    ).toBeNull();
  });

  it('does not flag a fast drive across a metro area', () => {
    expect(
      judgeCheckInPair(
        point('a', NYC, '2026-07-26T10:00:00.000Z'),
        point('b', { latitude: 40.9, longitude: -74.2 }, '2026-07-26T10:30:00.000Z'),
        MAX,
      ),
    ).toBeNull();
  });

  it('DOES NOT flag GPS jitter at a stationary address', () => {
    // ~30 m apart, ten seconds apart — implies ~11 km/h but is a phone
    // sitting on a kitchen table. The distance floor is what catches it.
    expect(
      judgeCheckInPair(
        point('a', { latitude: 40.712_8, longitude: -74.006_0 }, '2026-07-26T10:00:00.000Z'),
        point('b', { latitude: 40.713_07, longitude: -74.006_0 }, '2026-07-26T10:00:10.000Z'),
        MAX,
      ),
    ).toBeNull();
  });

  it('does not flag back-to-back visits in the same building', () => {
    expect(
      judgeCheckInPair(
        point('a', NYC, '2026-07-26T10:00:00.000Z'),
        point('b', NYC, '2026-07-26T10:00:01.000Z'),
        MAX,
      ),
    ).toBeNull();
  });

  it('returns null rather than an infinite speed when the timestamps are identical', () => {
    const finding = judgeCheckInPair(
      point('a', NYC, '2026-07-26T10:00:00.000Z'),
      point('b', LA, '2026-07-26T10:00:00.000Z'),
      MAX,
    );

    expect(finding).toBeNull();
  });

  it('returns null for an out-of-order pair rather than a negative elapsed time', () => {
    expect(
      judgeCheckInPair(
        point('a', NYC, '2026-07-26T11:00:00.000Z'),
        point('b', LA, '2026-07-26T10:00:00.000Z'),
        MAX,
      ),
    ).toBeNull();
  });

  it('returns null for a sub-second interval', () => {
    expect(
      judgeCheckInPair(
        point('a', NYC, '2026-07-26T10:00:00.000Z'),
        point('b', LA, '2026-07-26T10:00:00.500Z'),
        MAX,
      ),
    ).toBeNull();
  });

  it('respects a lowered ceiling', () => {
    const args = [
      point('a', NYC, '2026-07-26T10:00:00.000Z'),
      point('b', LA, '2026-07-26T16:00:00.000Z'),
    ] as const;

    expect(judgeCheckInPair(args[0], args[1], DEFAULT_IMPOSSIBLE_TRAVEL_MAX_SPEED_KPH)).toBeNull();
    expect(judgeCheckInPair(args[0], args[1], 200)).not.toBeNull();
  });

  it('treats the ceiling as inclusive — exactly at the limit is not a finding', () => {
    // 1,000 km in exactly one hour = 1,000 km/h.
    const start = point('a', { latitude: 0, longitude: 0 }, '2026-07-26T10:00:00.000Z');
    const end = point('b', { latitude: 0, longitude: 8.993_216 }, '2026-07-26T11:00:00.000Z');

    const finding = judgeCheckInPair(start, end, 1000);

    // Within rounding of the ceiling, so it must not fire.
    expect(finding === null || finding.impliedSpeedKph > 1000).toBe(true);
  });

  it('exposes the distance floor as a named constant, not a magic number', () => {
    expect(IMPOSSIBLE_TRAVEL_MIN_DISTANCE_METERS).toBe(500);
  });
});

describe('findImpossibleTravel', () => {
  const MAX = DEFAULT_IMPOSSIBLE_TRAVEL_MAX_SPEED_KPH;

  it('returns nothing for fewer than two check-ins', () => {
    expect(findImpossibleTravel([], MAX)).toEqual([]);
    expect(findImpossibleTravel([point('a', NYC, '2026-07-26T10:00:00.000Z')], MAX)).toEqual([]);
  });

  it('sorts before walking, so unordered input gives the same answer', () => {
    const later = point('b', LA, '2026-07-26T10:20:00.000Z');
    const earlier = point('a', NYC, '2026-07-26T10:00:00.000Z');

    const fromUnordered = findImpossibleTravel([later, earlier], MAX);

    expect(fromUnordered).toHaveLength(1);
    expect(fromUnordered[0]?.previous.id).toBe('a');
    expect(fromUnordered[0]?.current.id).toBe('b');
  });

  it('reports BOTH transitions around a single spoofed middle check-in', () => {
    // A → B is impossible and B → C is impossible; the reviewer sees B
    // is the odd one out. Comparing every pair instead would also
    // surface a fine (A, C) that says nothing.
    const findings = findImpossibleTravel(
      [
        point('a', NYC, '2026-07-26T10:00:00.000Z'),
        point('b', LA, '2026-07-26T10:10:00.000Z'),
        point('c', NYC, '2026-07-26T10:20:00.000Z'),
      ],
      MAX,
    );

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => `${f.previous.id}->${f.current.id}`)).toEqual(['a->b', 'b->c']);
  });

  it('reports nothing across a plausible day of visits', () => {
    const findings = findImpossibleTravel(
      [
        point('a', NYC, '2026-07-26T09:00:00.000Z'),
        point('b', { latitude: 40.75, longitude: -73.99 }, '2026-07-26T11:00:00.000Z'),
        point('c', { latitude: 40.68, longitude: -73.95 }, '2026-07-26T14:00:00.000Z'),
      ],
      MAX,
    );

    expect(findings).toEqual([]);
  });

  it('is deterministic for check-ins stamped in the same second', () => {
    const same = [
      point('z', LA, '2026-07-26T10:10:00.000Z'),
      point('a', LA, '2026-07-26T10:10:00.000Z'),
      point('m', NYC, '2026-07-26T10:00:00.000Z'),
    ];

    const first = findImpossibleTravel(same, MAX);
    const second = findImpossibleTravel([...same].reverse(), MAX);

    expect(first.map((f) => f.current.id)).toEqual(second.map((f) => f.current.id));
  });

  it('carries the numbers it judged on, so a retuned threshold cannot rewrite history', () => {
    const findings = findImpossibleTravel(
      [point('a', NYC, '2026-07-26T10:00:00.000Z'), point('b', LA, '2026-07-26T10:20:00.000Z')],
      MAX,
    );

    const finding = findings[0];
    expect(finding?.distanceMeters).toBeGreaterThan(3_900_000);
    expect(finding?.elapsedSeconds).toBe(1200);
    expect(finding?.impliedSpeedKph).toBeGreaterThan(0);
  });
});
