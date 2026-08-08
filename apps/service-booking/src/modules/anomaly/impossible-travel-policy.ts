/**
 * The impossible-travel predicate (TS-308a; PRD §10.13, PDD §17.3).
 *
 * Pure functions, no I/O, no Prisma — the whole judgement of what
 * counts as impossible lives here so it can be argued with in a test
 * rather than inferred from a query.
 */

/**
 * Mean Earth radius in metres (IUGG). The haversine below is a
 * spherical approximation; the ellipsoidal error is under ~0.5%, which
 * is three orders of magnitude smaller than the margin between "drove
 * across town" and "cannot have been both places".
 */
const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Default ceiling on implied travel speed, in km/h.
 *
 * **Sitting this number right is the whole task, so here is the
 * reasoning.** The ceiling has to sit ABOVE every legitimate way a
 * provider gets between two visits and BELOW anything a spoofed
 * check-in implies:
 *
 *   - Driving, even badly, tops out around 130 km/h sustained.
 *   - A provider who flies to a family emergency and works a visit at
 *     the other end is doing something entirely legitimate, and a
 *     short-haul jet cruises at 800–900 km/h. A ceiling below that
 *     opens a safety incident on someone for catching a plane — and an
 *     incident that fires on ordinary life is one operators learn to
 *     dismiss, which costs more than the detector is worth.
 *   - So the ceiling sits above commercial cruise: **1,000 km/h**.
 *     Above that the only explanations are a spoofed location, a
 *     mis-stamped clock, or a different person working the visit.
 *
 * **This is a defensible default, not a confirmed one.** Nobody has
 * validated it against real provider movement, because there is no real
 * provider movement yet. Same posture as TS-300's SLA budgets: named,
 * documented, configurable, and honest that it is unconfirmed rather
 * than blocking the detector on a number nobody can supply.
 *
 * Overridable per-environment via `BOOKING_ANOMALY_MAX_SPEED_KPH`.
 */
export const DEFAULT_IMPOSSIBLE_TRAVEL_MAX_SPEED_KPH = 1_000;

/**
 * Minimum separation, in metres, before a pair is considered at all.
 *
 * Two check-ins at the same address seconds apart imply an enormous
 * speed for a trivially benign reason: GPS jitter. A stationary phone's
 * fix wanders by tens of metres, and `location_accuracy_meters` is
 * frequently null, so the detector cannot rely on the device's own
 * estimate. 500 m is comfortably outside consumer-GPS noise and
 * comfortably inside "these are different places".
 *
 * This floor is what stops a provider who checks out and immediately
 * checks in to a back-to-back visit at the same building from being
 * reported.
 */
export const IMPOSSIBLE_TRAVEL_MIN_DISTANCE_METERS = 500;

/** A check-in reduced to what the predicate needs. */
export interface CheckInPoint {
  readonly id: string;
  readonly bookingId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly occurredAt: Date;
}

/** A pair the predicate judged impossible, with the numbers it judged on. */
export interface ImpossibleTravelFinding {
  readonly previous: CheckInPoint;
  readonly current: CheckInPoint;
  readonly distanceMeters: number;
  readonly elapsedSeconds: number;
  readonly impliedSpeedKph: number;
}

/**
 * Great-circle distance between two points in metres, via haversine.
 *
 * Returns whole metres — the caller puts this on an event, and metre
 * precision is already more than a reviewer needs. Sub-metre precision
 * would start to re-encode the coordinates themselves, which is exactly
 * what this event refuses to carry.
 */
export function greatCircleDistanceMeters(a: CheckInPoint, b: CheckInPoint): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  // `Math.min(1, …)` guards the floating-point case where h creeps just
  // above 1 for antipodal points and `Math.sqrt` would return NaN.
  const centralAngle = 2 * Math.asin(Math.min(1, Math.sqrt(h)));

  return Math.round(EARTH_RADIUS_METERS * centralAngle);
}

/**
 * Judge one consecutive pair. `null` means "nothing to report", which
 * covers every benign case:
 *
 *   - the two check-ins are close enough that GPS jitter explains it;
 *   - they share a timestamp, or arrive out of order — a zero or
 *     negative interval is a clock problem, not a travel claim, and
 *     dividing by it would manufacture an infinite speed;
 *   - the implied speed is within the ceiling.
 *
 * The pair must be supplied oldest-first; the caller sorts.
 */
export function judgeCheckInPair(
  previous: CheckInPoint,
  current: CheckInPoint,
  maxSpeedKph: number,
): ImpossibleTravelFinding | null {
  const elapsedMs = current.occurredAt.getTime() - previous.occurredAt.getTime();
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  if (elapsedSeconds < 1) return null;

  const distanceMeters = greatCircleDistanceMeters(previous, current);
  if (distanceMeters < IMPOSSIBLE_TRAVEL_MIN_DISTANCE_METERS) return null;

  const impliedSpeedKph = round1((distanceMeters / 1000 / elapsedSeconds) * 3600);
  if (impliedSpeedKph <= maxSpeedKph) return null;

  return { previous, current, distanceMeters, elapsedSeconds, impliedSpeedKph };
}

/**
 * Walk one provider's check-ins in time order and return every
 * consecutive pair that fails the predicate.
 *
 * **Consecutive pairs only, deliberately.** Comparing every pair would
 * be quadratic and would also re-report the same journey from several
 * angles: a provider whose middle check-in is spoofed produces a bad
 * (A,B) and a bad (B,C), and additionally a possibly-fine (A,C) that
 * says nothing new. The consecutive walk reports the two transitions
 * that are actually impossible and leaves the reviewer to see that B is
 * the odd one out.
 *
 * Input need not be sorted; this sorts by `occurredAt` and breaks ties
 * on `id` so the walk is deterministic for two check-ins stamped in the
 * same second (which `judgeCheckInPair` then discards anyway — but a
 * non-deterministic ORDER BY would make the surrounding pairs vary
 * between runs, and a detector that reports different findings from the
 * same data is one nobody trusts).
 */
export function findImpossibleTravel(
  checkIns: readonly CheckInPoint[],
  maxSpeedKph: number,
): readonly ImpossibleTravelFinding[] {
  if (checkIns.length < 2) return [];

  const ordered = [...checkIns].sort((a, b) => {
    const delta = a.occurredAt.getTime() - b.occurredAt.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });

  const findings: ImpossibleTravelFinding[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous === undefined || current === undefined) continue;
    const finding = judgeCheckInPair(previous, current, maxSpeedKph);
    if (finding !== null) findings.push(finding);
  }
  return findings;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
