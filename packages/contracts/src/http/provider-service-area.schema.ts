import { z } from 'zod';

/**
 * Provider service-area contracts (TS-202).
 *
 * The self-service editor surface (`GET /api/v1/providers/me/service-areas-
 * snapshot`, `PUT /api/v1/providers/:providerId/service-areas`, `DELETE
 * /api/v1/providers/:providerId/service-areas`) plus the per-provider
 * record shape consumed by:
 *   - the web-provider service-area editor (TS-202)
 *   - the discovery-doc projection (TS-053-followup-3 — the search-indexer
 *     reads the materialised `centroid` + `boundingBox` to drive the
 *     `ProviderDiscoveryDocument.centroid` field; geo-distance scoring is
 *     TS-210)
 *   - the booking-svc household-in-service-area gate (future — a household
 *     address that falls inside any of the provider's polygons is a
 *     bookability precondition)
 *
 * **Data shape rationale** (PRD §7.2; PDD §8.2 / §14.1).
 *
 * Each service area is a single GeoJSON `Polygon` (RFC 7946) with an
 * optional human label ("Upper East Side", "Brooklyn Heights"). A
 * provider declares one or many disjoint areas — a chef who serves
 * both Manhattan's UES and parts of Brooklyn declares two polygons.
 *
 * **GeoJSON, not PostGIS** (Phase-1 scope choice). The polygon is stored
 * verbatim in a `jsonb` column; the centroid + axis-aligned bounding box
 * are computed in application code at write time and persisted as plain
 * `double precision` columns. No PostGIS extension is required on the
 * Phase-1 self-managed Postgres. Polygon-intersection search ("is this
 * household address inside the polygon?") lands alongside the live
 * Elasticsearch geo wiring (TS-210); Phase-1 discovery uses the
 * pre-computed centroid + radius (PDD §14.1).
 *
 * **Coordinate order**. GeoJSON positions are `[longitude, latitude]`
 * (RFC 7946 §3.1.1) — the X-then-Y convention, the OPPOSITE of the
 * `{ latitude, longitude }` order the discovery `centroid` object uses.
 * The polygon coordinates keep the GeoJSON order so the wire shape is a
 * valid GeoJSON document a Mapbox / Leaflet client can render directly;
 * the derived `centroid` / `boundingBox` objects use the named-field
 * order so they read unambiguously.
 *
 * **Strict everywhere** — `.strict()` on every object schema rejects
 * unknown fields at the boundary (CLAUDE.md §3.3). Area count, ring
 * count, and vertices-per-ring are all bounded so a malformed admin
 * write cannot OOM the downstream or balloon the `jsonb` column.
 */

// ─── Bounded length / count constants ───────────────────────────────────

/** Soft FK length cap (providerId / id). Matches every other provider-domain id cap. */
export const PROVIDER_SERVICE_AREA_ID_MAX_LENGTH = 64;

/** Human label cap. Optional per-area name ("Upper East Side"). */
export const PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH = 120;

/**
 * Cap on distinct service-area polygons per provider. A chef serving
 * ten disjoint neighbourhoods is already an outlier; beyond that the
 * provider should declare a single larger polygon. Keeps the snapshot
 * payload + the discovery-doc projection bounded.
 */
export const PROVIDER_SERVICE_AREAS_MAX = 10;

/**
 * Cap on linear rings per polygon — 1 exterior ring + up to 15 interior
 * rings (holes). Holes let a provider carve a no-go zone out of an
 * otherwise-covered area; 15 is far past any realistic need but bounds
 * the worst case.
 */
export const PROVIDER_SERVICE_AREA_POLYGON_RINGS_MAX = 16;

/**
 * Cap on positions per linear ring (including the closing position that
 * repeats the first). 500 vertices renders a high-fidelity neighbourhood
 * boundary; the Mapbox draw widget (TS-202-followup-1) will typically
 * emit far fewer. The minimum is 4 — three distinct corners plus the
 * closing repeat (a triangle is the smallest valid polygon).
 */
export const PROVIDER_SERVICE_AREA_RING_VERTICES_MIN = 4;
export const PROVIDER_SERVICE_AREA_RING_VERTICES_MAX = 500;

/**
 * Cap on a single service-area polygon's total area (exterior minus
 * holes) in square kilometres (TS-202-followup-3). A provider serves a
 * neighbourhood, a cluster of neighbourhoods, or at most a metro area —
 * the full NYC metropolitan area is ~34,500 km², comfortably under this
 * cap. A polygon spanning a whole state (Rhode Island ~4,000 km²,
 * Connecticut ~14,400 km²) still fits; one "covering" a continent
 * (millions of km²) is almost certainly a coordinate-order or
 * units error and is rejected at the boundary. The exact value is a
 * deliberately generous upper bound — it exists to catch gross errors,
 * not to police legitimate coverage choices.
 */
export const PROVIDER_SERVICE_AREA_MAX_AREA_SQ_KM = 50_000;

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().min(1).max(PROVIDER_SERVICE_AREA_ID_MAX_LENGTH);

/**
 * Latitude / longitude in WGS84 decimal degrees. Mirrors the bounds in
 * `provider-discovery.schema.ts` (kept independent to avoid a circular
 * import). Six fractional digits is ~10 cm at the equator — more than
 * enough for provider geo-discovery.
 */
const LongitudeSchema = z.number().gte(-180).lte(180);
const LatitudeSchema = z.number().gte(-90).lte(90);

/**
 * A single GeoJSON position — `[longitude, latitude]` (RFC 7946
 * §3.1.1). Altitude (a third tuple element) is NOT accepted; service
 * areas are 2-D. `.strict` on the tuple via the fixed two-element shape
 * rejects extra coordinates.
 */
export const GeoPositionSchema = z.tuple([LongitudeSchema, LatitudeSchema]);
export type GeoPosition = z.infer<typeof GeoPositionSchema>;

/**
 * A GeoJSON linear ring — a closed loop of positions. RFC 7946 §3.1.6
 * requires the first and last positions to be identical (the ring is
 * explicitly closed) and at least 4 positions total. The `superRefine`
 * enforces the closure invariant; the `.min` / `.max` bound the vertex
 * count.
 */
export const GeoLinearRingSchema = z
  .array(GeoPositionSchema)
  .min(
    PROVIDER_SERVICE_AREA_RING_VERTICES_MIN,
    `a linear ring needs at least ${PROVIDER_SERVICE_AREA_RING_VERTICES_MIN} positions (3 corners + the closing repeat)`,
  )
  .max(
    PROVIDER_SERVICE_AREA_RING_VERTICES_MAX,
    `a linear ring may carry at most ${PROVIDER_SERVICE_AREA_RING_VERTICES_MAX} positions`,
  )
  .superRefine((ring, ctx) => {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first === undefined || last === undefined) return;
    if (first[0] !== last[0] || first[1] !== last[1]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'linear ring must be closed — the first and last positions must be identical (RFC 7946 §3.1.6)',
      });
    }
  });
export type GeoLinearRing = z.infer<typeof GeoLinearRingSchema>;

/**
 * A GeoJSON `Polygon` (RFC 7946 §3.1.6). `coordinates[0]` is the
 * exterior ring; any subsequent rings are interior holes.
 *
 * Beyond the per-ring closure + vertex-count checks (`GeoLinearRingSchema`)
 * and the ring-count cap, the `superRefine` enforces geometric validity
 * (TS-202-followup-3) so a stored polygon is directly usable by the live
 * geo-search wiring (TS-210) and the point-in-polygon bookability gate:
 *
 *   1. **Non-degenerate** — every ring must enclose a non-zero area; a
 *      collinear / zero-area ring is rejected.
 *   2. **Simple** — no ring may self-intersect (a "bowtie", or a ring
 *      that pinches back on itself at a vertex, is rejected). Both
 *      Elasticsearch `geo_shape` and point-in-polygon tests require
 *      simple rings.
 *   3. **Right-hand-rule winding** (RFC 7946 §3.1.6) — the exterior ring
 *      must wind counterclockwise; every interior hole must wind
 *      clockwise. A wrong-winding ring is *rejected* (not silently
 *      normalised) with an actionable "reverse the coordinate order"
 *      message, so the stored bytes match what the client sent and ES
 *      ingests the polygon without an orientation fix-up.
 *   4. **Bounded area** — the polygon's total area (exterior − holes)
 *      must not exceed `PROVIDER_SERVICE_AREA_MAX_AREA_SQ_KM`.
 *
 * All four reject at the boundary with a 400 before any DB hit, mirroring
 * the existing closure check. The refinement runs on both the input (PUT
 * body) and output (record) shapes because the polygon round-trips
 * verbatim through the `jsonb` column — a polygon that passed on write
 * necessarily passes on read, so the read path never spuriously rejects.
 *
 * Before TS-202-followup-3 the centroid/bbox computation tolerated either
 * winding (its signed-area formula uses the magnitude); that remains true
 * as defence-in-depth, but the boundary now guarantees RHR input.
 */
export const GeoPolygonSchema = z
  .object({
    type: z.literal('Polygon'),
    coordinates: z
      .array(GeoLinearRingSchema)
      .min(1, 'a polygon needs at least one (exterior) ring')
      .max(
        PROVIDER_SERVICE_AREA_POLYGON_RINGS_MAX,
        `a polygon may carry at most ${PROVIDER_SERVICE_AREA_POLYGON_RINGS_MAX} rings (1 exterior + holes)`,
      ),
  })
  .strict()
  .superRefine((polygon, ctx) => {
    polygon.coordinates.forEach((ring, index) => {
      // Defensive: `GeoLinearRingSchema` already enforced closure + the
      // 4..500 vertex bound, so this guards only against a hand-built
      // value that bypassed the nested schema.
      if (ring.length < 4) return;

      const isExterior = index === 0;
      const ringLabel = isExterior ? 'exterior ring' : `interior ring (hole) #${index}`;
      const signedArea = geoRingSignedAreaDeg2(ring);

      if (signedArea === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordinates', index],
          message: `${ringLabel} is degenerate — its positions are collinear and enclose zero area`,
        });
        // A zero-area ring has no defined winding; skip the winding check.
        return;
      }

      if (!geoRingIsSimple(ring)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordinates', index],
          message: `${ringLabel} is self-intersecting — polygon rings must be simple (non-self-crossing)`,
        });
      }

      // RFC 7946 §3.1.6 right-hand rule: exterior CCW (signed area > 0),
      // holes CW (signed area < 0), under the GeoJSON [lng, lat] axes.
      if (isExterior && signedArea < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordinates', index],
          message:
            'exterior ring must wind counterclockwise (RFC 7946 §3.1.6 right-hand rule); reverse the coordinate order',
        });
      } else if (!isExterior && signedArea > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coordinates', index],
          message:
            'interior ring (hole) must wind clockwise (RFC 7946 §3.1.6 right-hand rule); reverse the coordinate order',
        });
      }
    });

    const areaSqKm = geoPolygonApproxAreaSqKm(polygon);
    if (areaSqKm > PROVIDER_SERVICE_AREA_MAX_AREA_SQ_KM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['coordinates'],
        message: `service-area polygon area (~${Math.round(areaSqKm)} km²) exceeds the cap of ${PROVIDER_SERVICE_AREA_MAX_AREA_SQ_KM} km²`,
      });
    }
  });
export type GeoPolygon = z.infer<typeof GeoPolygonSchema>;

/**
 * Pre-computed centroid (named-field order, NOT GeoJSON order). The
 * service computes the planar area-weighted centroid of the exterior
 * ring at write time. Phase-1 discovery search reads this for the
 * centroid + radius scoring (PDD §14.1).
 */
export const GeoCentroidSchema = z
  .object({
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
  })
  .strict();
export type GeoCentroid = z.infer<typeof GeoCentroidSchema>;

/**
 * Pre-computed axis-aligned bounding box. `min*` ≤ `max*` is guaranteed
 * by the service's computation; the schema does not re-assert it (the
 * derived value is server-owned, never client-supplied).
 */
export const GeoBoundingBoxSchema = z
  .object({
    minLatitude: LatitudeSchema,
    minLongitude: LongitudeSchema,
    maxLatitude: LatitudeSchema,
    maxLongitude: LongitudeSchema,
  })
  .strict();
export type GeoBoundingBox = z.infer<typeof GeoBoundingBoxSchema>;

// ─── Input shape (one area in a PUT body) ───────────────────────────────

/**
 * One service area as supplied by the client on a PUT. `label` is
 * optional — null / omitted both mean "unlabelled". The polygon is the
 * only required field; the centroid + bounding box are derived
 * server-side (never client-supplied — a client that POSTed a centroid
 * would have it ignored, so the input shape simply doesn't carry one).
 */
export const ProviderServiceAreaInputSchema = z
  .object({
    label: z.string().min(1).max(PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH).nullish(),
    polygon: GeoPolygonSchema,
  })
  .strict();
export type ProviderServiceAreaInput = z.infer<typeof ProviderServiceAreaInputSchema>;

// ─── Record shape (one area in a response) ──────────────────────────────

/**
 * The materialised shape for one persisted service area. `label` is
 * nullable (null = unlabelled). `polygon` round-trips the stored
 * GeoJSON verbatim. `centroid` + `boundingBox` are the server-computed
 * derivations the search-indexer consumes. `createdAt` / `updatedAt`
 * are ISO-8601.
 */
export const ProviderServiceAreaRecordSchema = z
  .object({
    id: IdSchema,
    providerId: IdSchema,
    label: z.string().min(1).max(PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH).nullable(),
    polygon: GeoPolygonSchema,
    centroid: GeoCentroidSchema,
    boundingBox: GeoBoundingBoxSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProviderServiceAreaRecord = z.infer<typeof ProviderServiceAreaRecordSchema>;

// ─── Snapshot / request / response shapes ───────────────────────────────

/**
 * Response body for `GET /api/v1/providers/me/service-areas-snapshot`
 * (TS-202).
 *
 *   - `{ providerId: null, serviceAreas: null }` — the authenticated
 *     user has no provider row yet (they haven't completed the
 *     application). The editor renders an empty-state placeholder.
 *   - `{ providerId: 'prv_x', serviceAreas: [] }` — a live provider who
 *     has not yet drawn any area. The editor renders the "draw your
 *     first area" surface; the `providerId` is carried so the editor's
 *     PUT has a target even with zero existing rows.
 *   - `{ providerId: 'prv_x', serviceAreas: [...] }` — at least one
 *     area on file.
 *
 * Carrying `providerId` separately (rather than relying on the first
 * record's `providerId`) is what makes the empty-set "add your first
 * area" flow work without a second profile round-trip.
 */
export const ProviderServiceAreasSnapshotResponseSchema = z
  .object({
    providerId: IdSchema.nullable(),
    serviceAreas: z
      .array(ProviderServiceAreaRecordSchema)
      .max(PROVIDER_SERVICE_AREAS_MAX)
      .nullable(),
  })
  .strict();
export type ProviderServiceAreasSnapshotResponse = z.infer<
  typeof ProviderServiceAreasSnapshotResponseSchema
>;

/**
 * Request body for `PUT /api/v1/providers/:providerId/service-areas`
 * (TS-202).
 *
 * Update semantics:
 *   - `serviceAreas` is a full-set replacement. The server runs `DELETE`
 *     + bulk-`INSERT` inside one transaction; consumers see the
 *     resulting set atomically. Submitting an empty array clears every
 *     area (equivalent to a DELETE on the resource, though the DELETE
 *     endpoint is the more idiomatic gesture).
 *   - Malformed polygons (open ring, < 4 positions, out-of-range
 *     lat/lng) reject at the boundary with a 400 before any DB hit.
 *
 * `providerId` is taken from the path param, NOT the body, so there is
 * no path/body mismatch ambiguity to resolve.
 */
export const UpdateProviderServiceAreasRequestSchema = z
  .object({
    serviceAreas: z
      .array(ProviderServiceAreaInputSchema)
      .max(
        PROVIDER_SERVICE_AREAS_MAX,
        `at most ${PROVIDER_SERVICE_AREAS_MAX} service areas per provider`,
      ),
  })
  .strict();
export type UpdateProviderServiceAreasRequest = z.infer<
  typeof UpdateProviderServiceAreasRequestSchema
>;

/**
 * Response body for `PUT /api/v1/providers/:providerId/service-areas`.
 * Wraps the materialised records so the shape is forward-compatible with
 * future side-payloads (e.g. a derived discovery-doc snapshot for
 * client-side cache pre-warm) without a v1 break.
 */
export const UpdateProviderServiceAreasResponseSchema = z
  .object({
    serviceAreas: z.array(ProviderServiceAreaRecordSchema).max(PROVIDER_SERVICE_AREAS_MAX),
  })
  .strict();
export type UpdateProviderServiceAreasResponse = z.infer<
  typeof UpdateProviderServiceAreasResponseSchema
>;

/**
 * Response body for `DELETE /api/v1/providers/:providerId/service-areas`.
 * Always returns 200 — a delete on an already-empty set is a no-op
 * success. `deletedCount` carries the number of rows actually removed so
 * the editor can surface a "no areas were saved" hint when the user
 * clicks delete on an empty set.
 */
export const DeleteProviderServiceAreasResponseSchema = z
  .object({
    providerId: IdSchema,
    deletedCount: z.number().int().nonnegative(),
  })
  .strict();
export type DeleteProviderServiceAreasResponse = z.infer<
  typeof DeleteProviderServiceAreasResponseSchema
>;

// ─── Geometric-validity helpers (TS-202-followup-3) ─────────────────────
//
// Pure functions backing `GeoPolygonSchema`'s geometric refinement.
// Declared after the schemas (and reached via JS function hoisting from
// the `superRefine` above) so the schema-definition block stays
// contiguous, matching the geo-helper placement in
// `apps/service-provider/.../service-areas.service.ts`. Exported so the
// service layer / discovery projection / tests can reuse one source of
// truth for ring winding, simplicity, and area.

/**
 * Signed planar area of a linear ring via the shoelace formula, treating
 * each `[longitude, latitude]` position as a Cartesian `(x, y)` point
 * (units: degrees²). The SIGN encodes winding under the GeoJSON axis
 * convention (x = longitude east-positive, y = latitude north-positive):
 *
 *   - `> 0` → counterclockwise (CCW) — a GeoJSON exterior ring.
 *   - `< 0` → clockwise (CW) — a GeoJSON interior ring (hole).
 *   - `= 0` → degenerate (collinear / zero-area).
 *
 * The closing repeat position contributes a zero-area term, so an
 * explicitly-closed ring and its open form yield the same value.
 */
export function geoRingSignedAreaDeg2(ring: readonly GeoPosition[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (a === undefined || b === undefined) continue;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/**
 * Whether a linear ring is *simple* — no two non-adjacent edges cross or
 * touch. A self-intersecting ring (a "bowtie", or a ring that pinches
 * back on itself at a vertex) is not a valid polygon boundary and breaks
 * downstream point-in-polygon / Elasticsearch `geo_shape` semantics.
 *
 * O(n²) over the ring's edges — bounded by
 * `PROVIDER_SERVICE_AREA_RING_VERTICES_MAX` (500), so worst-case
 * ~125k segment-pair tests per ring at the write boundary. Adjacent
 * edges (sharing a vertex — the sequential pair and a closed ring's
 * wrap-around first/last pair) are skipped; every other pair is tested
 * with an orientation-based predicate that also catches collinear
 * overlap.
 */
export function geoRingIsSimple(ring: readonly GeoPosition[]): boolean {
  const edgeCount = ring.length - 1;
  for (let i = 0; i < edgeCount; i++) {
    const p1 = ring[i];
    const q1 = ring[i + 1];
    if (p1 === undefined || q1 === undefined) continue;
    for (let j = i + 1; j < edgeCount; j++) {
      // Adjacent edges legitimately share exactly one endpoint — the
      // sequential pair (j === i + 1) and the closed-ring wrap-around
      // pair (first edge ↔ last edge).
      if (j === i + 1) continue;
      if (i === 0 && j === edgeCount - 1) continue;
      const p2 = ring[j];
      const q2 = ring[j + 1];
      if (p2 === undefined || q2 === undefined) continue;
      if (segmentsIntersect(p1, q1, p2, q2)) return false;
    }
  }
  return true;
}

/**
 * Approximate area of a GeoJSON polygon in km² — the exterior ring's
 * area minus every interior hole. Each ring's degree² shoelace magnitude
 * is scaled by the local metric lengths of a degree (latitude ≈ 110.574
 * km everywhere; longitude ≈ 111.320 km × cos(latitude), evaluated at the
 * exterior ring's mean latitude). Accurate at the neighbourhood-to-metro
 * scale this surface serves; the cap it backs only needs to separate a
 * legitimate metro from a state/continent-sized error, so the planar
 * approximation is more than sufficient.
 */
export function geoPolygonApproxAreaSqKm(polygon: GeoPolygon): number {
  const exterior = polygon.coordinates[0];
  if (exterior === undefined || exterior.length < 4) return 0;

  const KM_PER_DEG_LAT = 110.574;
  const KM_PER_DEG_LNG_EQUATOR = 111.32;
  const meanLatRad = (geoRingMeanLatitude(exterior) * Math.PI) / 180;
  const kmPerDegLng = KM_PER_DEG_LNG_EQUATOR * Math.cos(meanLatRad);
  const degSqToKmSq = KM_PER_DEG_LAT * Math.abs(kmPerDegLng);

  let total = 0;
  for (let i = 0; i < polygon.coordinates.length; i++) {
    const ring = polygon.coordinates[i];
    if (ring === undefined) continue;
    const kmSq = Math.abs(geoRingSignedAreaDeg2(ring)) * degSqToKmSq;
    if (i === 0) total += kmSq;
    else total -= kmSq;
  }
  return total > 0 ? total : 0;
}

/** Mean latitude of a ring's distinct vertices (excludes the closing repeat). */
function geoRingMeanLatitude(ring: readonly GeoPosition[]): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const p = ring[i];
    if (p === undefined) continue;
    sum += p[1];
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/** Orientation of the ordered triple (p, q, r): 0 collinear, 1 CW, 2 CCW. */
function orientation(p: GeoPosition, q: GeoPosition, r: GeoPosition): 0 | 1 | 2 {
  const val = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  if (val === 0) return 0;
  return val > 0 ? 1 : 2;
}

/** Whether point `q` lies on segment `pr`, given p, q, r are collinear. */
function onSegment(p: GeoPosition, q: GeoPosition, r: GeoPosition): boolean {
  return (
    q[0] <= Math.max(p[0], r[0]) &&
    q[0] >= Math.min(p[0], r[0]) &&
    q[1] <= Math.max(p[1], r[1]) &&
    q[1] >= Math.min(p[1], r[1])
  );
}

/**
 * Whether segment `p1q1` intersects segment `p2q2` (proper crossing or
 * collinear touch). Standard orientation-based predicate (CLRS §33.1).
 */
function segmentsIntersect(
  p1: GeoPosition,
  q1: GeoPosition,
  p2: GeoPosition,
  q2: GeoPosition,
): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}
