import { Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_SERVICE_AREAS_UPDATED,
  type GeoBoundingBox,
  type GeoCentroid,
  type GeoPolygon,
  type GeoPosition,
  type ProviderServiceAreaInput,
  type ProviderServiceAreaRecord,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `providers` row shape — same
 * TS-021-followup-2 / TS-021-followup-3 rationale that the sibling
 * profile + availability + discovery services use.
 */
interface ProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly deletedAt: Date | null;
}

/** Local mirror of a `provider_service_areas` row's projected columns. */
interface ServiceAreaRow {
  readonly id: string;
  readonly providerId: string;
  readonly label: string | null;
  readonly geoPolygon: unknown;
  readonly centroidLatitude: number;
  readonly centroidLongitude: number;
  readonly bboxMinLatitude: number;
  readonly bboxMinLongitude: number;
  readonly bboxMaxLatitude: number;
  readonly bboxMaxLongitude: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SERVICE_AREA_ROW_SELECT = {
  id: true,
  providerId: true,
  label: true,
  geoPolygon: true,
  centroidLatitude: true,
  centroidLongitude: true,
  bboxMinLatitude: true,
  bboxMinLongitude: true,
  bboxMaxLatitude: true,
  bboxMaxLongitude: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface UpdateServiceAreasInput {
  /** Authoritative provider row id — set from the route param. */
  readonly providerId: string;
  /** The authenticated user attempting the edit. */
  readonly actorUserId: string;
  readonly serviceAreas: readonly ProviderServiceAreaInput[];
}

export interface DeleteServiceAreasInput {
  readonly providerId: string;
  readonly actorUserId: string;
}

export type ProviderServiceAreasFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'not_found'; readonly providerId: string }
  | { readonly reason: 'forbidden'; readonly providerId: string }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

export interface DeleteServiceAreasOutcome {
  readonly providerId: string;
  readonly deletedCount: number;
}

/**
 * The authenticated-user snapshot shape. Carries the resolved
 * `providerId` alongside the materialised records so the editor's PUT
 * has a target even when the area set is empty (the common "add your
 * first area" path). `null` is returned only when the user has no
 * provider row at all.
 */
export interface ProviderServiceAreasSnapshot {
  readonly providerId: string;
  readonly serviceAreas: ProviderServiceAreaRecord[];
}

/**
 * Internal exception thrown inside `prisma.$transaction` when the
 * outbox SDK rejects the payload. Caught by the outer service so the
 * surrounding transaction rolls back atomically and we surface a
 * typed failure rather than a 500. Same shape as the sibling
 * profile + availability + certifications services.
 */
class OutboxValidationFailedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`outbox.append validation failed for ${eventName}`);
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * `ServiceAreasService` — owns the self-service provider coverage
 * surface (TS-202).
 *
 * Three surfaces:
 *
 *   - `getServiceAreas(providerId)` / `getServiceAreasByUserId(userId)`
 *     — return the materialised set of coverage polygons. Returns
 *     `null` when the provider row is missing / soft-deleted (the
 *     editor renders an empty-state placeholder); a live provider
 *     with no areas returns an empty array.
 *
 *   - `updateServiceAreas({ providerId, actorUserId, serviceAreas })`
 *     — atomic full-set replace via `prisma.$transaction`:
 *       1. Loads the provider row (404 if missing / soft-deleted).
 *       2. Verifies `user_id` matches `actorUserId` (403 otherwise;
 *          admin override is TS-202-followup-2).
 *       3. DELETEs every existing area row, then bulk-inserts the new
 *          set — each row carrying the server-computed centroid +
 *          bounding box (planar, GeoJSON, no PostGIS).
 *       4. Appends `provider.service_areas_updated` via the shared
 *          outbox SDK. Rolls back atomically on validation failure.
 *       5. Re-reads + materialises the response set.
 *
 *   - `deleteServiceAreas({ providerId, actorUserId })` —
 *     transactional full-clear (same ownership check, same outbox
 *     emission). Returns the count of rows actually removed.
 *
 * **Tenant scoping** (CLAUDE.md §3.2). Self-service-first: the
 * authenticated user must own the provider row. Admin override lands
 * when `PermissionGuard` lifts to `packages/nest-auth` via
 * TS-052-followup-11 — captured as TS-202-followup-2.
 *
 * **Geo computation**. Centroid + bounding box are computed in
 * application code (`computeCentroid` / `computeBoundingBox`) at write
 * time — no PostGIS extension on the Phase-1 self-managed Postgres.
 * The search-indexer (TS-053-followup-3) reads the centroid into the
 * discovery doc; geo-distance / polygon-intersection scoring lands
 * with TS-210.
 *
 * **Outbox emission**. `provider.service_areas_updated` carries the
 * post-write area count; the search-indexer treats the event as a
 * "re-fetch + re-project" trigger via the discovery-snapshot endpoint
 * so the event stays tiny and the projection stays
 * single-source-of-truth.
 */
@Injectable()
export class ServiceAreasService {
  private readonly logger = new Logger(ServiceAreasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async getServiceAreas(providerId: string): Promise<ProviderServiceAreaRecord[] | null> {
    if (providerId.length === 0) return null;

    const provider = (await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, userId: true, deletedAt: true },
    })) as ProviderRow | null;

    if (provider === null || provider.deletedAt !== null) return null;

    const rows = (await this.prisma.providerServiceArea.findMany({
      where: { providerId: provider.id },
      select: SERVICE_AREA_ROW_SELECT,
    })) as readonly ServiceAreaRow[];

    return rows.map((row) => toProviderServiceAreaRecord(row));
  }

  async getServiceAreasByUserId(userId: string): Promise<ProviderServiceAreasSnapshot | null> {
    if (userId.length === 0) return null;

    const provider = (await this.prisma.provider.findUnique({
      where: { userId },
      select: { id: true, userId: true, deletedAt: true },
    })) as ProviderRow | null;

    if (provider === null || provider.deletedAt !== null) return null;

    const rows = (await this.prisma.providerServiceArea.findMany({
      where: { providerId: provider.id },
      select: SERVICE_AREA_ROW_SELECT,
    })) as readonly ServiceAreaRow[];

    return {
      providerId: provider.id,
      serviceAreas: rows.map((row) => toProviderServiceAreaRecord(row)),
    };
  }

  async updateServiceAreas(
    input: UpdateServiceAreasInput,
  ): Promise<Result<ProviderServiceAreaRecord[], ProviderServiceAreasFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }

    const provider = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
      select: { id: true, userId: true, deletedAt: true },
    })) as ProviderRow | null;

    if (provider === null || provider.deletedAt !== null) {
      return err({ reason: 'not_found', providerId: input.providerId });
    }
    if (provider.userId !== input.actorUserId) {
      return err({ reason: 'forbidden', providerId: input.providerId });
    }

    // Compute the derived geo columns OUTSIDE the transaction — pure
    // CPU work that does not need to hold a DB lock.
    const insertRows = input.serviceAreas.map((area) => {
      const boundingBox = computeBoundingBox(area.polygon);
      const centroid = computeCentroid(area.polygon, boundingBox);
      return {
        providerId: input.providerId,
        label: area.label ?? null,
        // GeoJSON Polygon → the `geo_polygon` jsonb column. Prisma's
        // generated `createMany` input contextually types this against
        // its Json input shape; the structural object is assignable.
        geoPolygon: area.polygon,
        centroidLatitude: centroid.latitude,
        centroidLongitude: centroid.longitude,
        bboxMinLatitude: boundingBox.minLatitude,
        bboxMinLongitude: boundingBox.minLongitude,
        bboxMaxLatitude: boundingBox.maxLatitude,
        bboxMaxLongitude: boundingBox.maxLongitude,
      };
    });

    const now = new Date();

    try {
      const records = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<ProviderServiceAreaRecord[]> => {
          // 1. Replace the coverage set. The DELETE + createMany pair
          //    runs inside the transaction so consumers see the
          //    resulting set atomically from the outside.
          await tx.providerServiceArea.deleteMany({
            where: { providerId: input.providerId },
          });
          if (insertRows.length > 0) {
            await tx.providerServiceArea.createMany({ data: insertRows });
          }

          // 2. Outbox emission. The producer ALWAYS fires on a PUT.
          const eventId = `${input.providerId}.service_areas_updated.${now.getTime()}`;
          const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
            eventName: PROVIDER_SERVICE_AREAS_UPDATED,
            eventId,
            occurredAt: now,
            payload: {
              eventId,
              occurredAt: now.toISOString(),
              providerId: input.providerId,
              areaCount: insertRows.length,
              actorUserId: input.actorUserId,
            },
          });
          if (appended.kind !== 'appended') {
            throw new OutboxValidationFailedError(appended.eventName, appended.issues);
          }

          // 3. Re-read the post-write rows for the response. Using the
          //    same tx ensures read-after-write consistency.
          const written = (await tx.providerServiceArea.findMany({
            where: { providerId: input.providerId },
            select: SERVICE_AREA_ROW_SELECT,
          })) as readonly ServiceAreaRow[];

          return written.map((row) => toProviderServiceAreaRecord(row));
        },
      );

      this.logger.log(
        {
          providerId: input.providerId,
          actorUserId: input.actorUserId,
          areaCount: insertRows.length,
        },
        'provider-service-areas.update ok',
      );

      return ok(records);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues, providerId: input.providerId },
          'provider-service-areas.update outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }

  async deleteServiceAreas(
    input: DeleteServiceAreasInput,
  ): Promise<Result<DeleteServiceAreasOutcome, ProviderServiceAreasFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'actorUserId is required' });
    }

    const provider = (await this.prisma.provider.findUnique({
      where: { id: input.providerId },
      select: { id: true, userId: true, deletedAt: true },
    })) as ProviderRow | null;

    if (provider === null || provider.deletedAt !== null) {
      return err({ reason: 'not_found', providerId: input.providerId });
    }
    if (provider.userId !== input.actorUserId) {
      return err({ reason: 'forbidden', providerId: input.providerId });
    }

    const now = new Date();

    try {
      const outcome = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<DeleteServiceAreasOutcome> => {
          const deleted = await tx.providerServiceArea.deleteMany({
            where: { providerId: input.providerId },
          });

          // Emit only when the delete actually removed something — a
          // delete on an already-empty set is a no-op success with no
          // domain change to broadcast.
          if (deleted.count > 0) {
            const eventId = `${input.providerId}.service_areas_updated.${now.getTime()}`;
            const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
              eventName: PROVIDER_SERVICE_AREAS_UPDATED,
              eventId,
              occurredAt: now,
              payload: {
                eventId,
                occurredAt: now.toISOString(),
                providerId: input.providerId,
                areaCount: 0,
                actorUserId: input.actorUserId,
              },
            });
            if (appended.kind !== 'appended') {
              throw new OutboxValidationFailedError(appended.eventName, appended.issues);
            }
          }

          return { providerId: input.providerId, deletedCount: deleted.count };
        },
      );

      this.logger.log(
        {
          providerId: input.providerId,
          actorUserId: input.actorUserId,
          deletedCount: outcome.deletedCount,
        },
        'provider-service-areas.delete ok',
      );

      return ok(outcome);
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { eventName: e.eventName, issues: e.issues, providerId: input.providerId },
          'provider-service-areas.delete outbox validation failed; tx rolled back',
        );
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }
  }
}

/**
 * Materialise a `ProviderServiceAreaRecord` DTO from a persisted row.
 * The polygon is round-tripped verbatim from the `jsonb` column; the
 * controller re-validates the assembled record through
 * `ProviderServiceAreaRecordSchema.parse` so a corrupt stored polygon
 * surfaces loudly rather than leaking to the client.
 *
 * Exported as a free function so the controller + the (future)
 * discovery-snapshot projection share one source of truth.
 */
export function toProviderServiceAreaRecord(row: ServiceAreaRowLike): ProviderServiceAreaRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    polygon: row.geoPolygon as unknown as GeoPolygon,
    centroid: { latitude: row.centroidLatitude, longitude: row.centroidLongitude },
    boundingBox: {
      minLatitude: row.bboxMinLatitude,
      minLongitude: row.bboxMinLongitude,
      maxLatitude: row.bboxMaxLatitude,
      maxLongitude: row.bboxMaxLongitude,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The subset of a service-area row `toProviderServiceAreaRecord` needs. */
export interface ServiceAreaRowLike {
  readonly id: string;
  readonly providerId: string;
  readonly label: string | null;
  readonly geoPolygon: unknown;
  readonly centroidLatitude: number;
  readonly centroidLongitude: number;
  readonly bboxMinLatitude: number;
  readonly bboxMinLongitude: number;
  readonly bboxMaxLatitude: number;
  readonly bboxMaxLongitude: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Round a coordinate to six fractional digits (~10 cm at the equator).
 * Keeps the persisted centroid clean and inside the contract's lat/lng
 * bounds without floating-point drift surfacing on the wire.
 */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Axis-aligned bounding box over every position in every ring of a
 * polygon. Pure; exported for unit testing + future discovery reuse.
 */
export function computeBoundingBox(polygon: GeoPolygon): GeoBoundingBox {
  let minLongitude = Number.POSITIVE_INFINITY;
  let minLatitude = Number.POSITIVE_INFINITY;
  let maxLongitude = Number.NEGATIVE_INFINITY;
  let maxLatitude = Number.NEGATIVE_INFINITY;

  for (const ring of polygon.coordinates) {
    for (const position of ring) {
      const longitude = position[0];
      const latitude = position[1];
      if (longitude < minLongitude) minLongitude = longitude;
      if (longitude > maxLongitude) maxLongitude = longitude;
      if (latitude < minLatitude) minLatitude = latitude;
      if (latitude > maxLatitude) maxLatitude = latitude;
    }
  }

  return {
    minLatitude: round6(minLatitude),
    minLongitude: round6(minLongitude),
    maxLatitude: round6(maxLatitude),
    maxLongitude: round6(maxLongitude),
  };
}

/**
 * Planar (treating lng/lat as Cartesian) area-weighted centroid of a
 * polygon's exterior ring. Good enough for Phase-1 centroid + radius
 * discovery scoring over neighbourhood-scale areas; a spherical
 * centroid lands if/when continental-scale areas appear. Falls back to
 * the arithmetic mean of the distinct vertices for a degenerate
 * (zero-area) ring, and clamps the result into the bounding box as a
 * defence against floating drift / self-intersecting input pushing the
 * centroid marginally outside the polygon's extent.
 *
 * Pure; exported for unit testing + future discovery reuse.
 */
export function computeCentroid(
  polygon: GeoPolygon,
  boundingBox: GeoBoundingBox = computeBoundingBox(polygon),
): GeoCentroid {
  const ring = polygon.coordinates[0];
  if (ring === undefined || ring.length < 4) {
    // Should be unreachable — the contract layer rejects rings under
    // 4 positions — but stay defensive against a direct-write path.
    return { latitude: boundingBox.minLatitude, longitude: boundingBox.minLongitude };
  }

  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const current = ring[i];
    const next = ring[i + 1];
    if (current === undefined || next === undefined) continue;
    const x0 = current[0];
    const y0 = current[1];
    const x1 = next[0];
    const y1 = next[1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area *= 0.5;

  if (area === 0) {
    return averageOfVertices(ring, boundingBox);
  }

  const longitude = clamp(cx / (6 * area), boundingBox.minLongitude, boundingBox.maxLongitude);
  const latitude = clamp(cy / (6 * area), boundingBox.minLatitude, boundingBox.maxLatitude);
  return { latitude: round6(latitude), longitude: round6(longitude) };
}

/**
 * Arithmetic mean of the distinct vertices (excluding the closing
 * repeat). Used as the degenerate-ring fallback.
 */
function averageOfVertices(ring: readonly GeoPosition[], boundingBox: GeoBoundingBox): GeoCentroid {
  let sumLongitude = 0;
  let sumLatitude = 0;
  let count = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const position = ring[i];
    if (position === undefined) continue;
    sumLongitude += position[0];
    sumLatitude += position[1];
    count += 1;
  }
  if (count === 0) {
    return { latitude: boundingBox.minLatitude, longitude: boundingBox.minLongitude };
  }
  return {
    latitude: round6(sumLatitude / count),
    longitude: round6(sumLongitude / count),
  };
}

/**
 * Absolute planar area of a polygon's exterior ring (shoelace formula,
 * treating lng/lat as Cartesian). Winding-order-agnostic — the sign of
 * the signed area encodes orientation, and we only ever use the
 * magnitude as a relative weight, so the absolute value is what callers
 * want. A degenerate (collinear / under-4-position) ring returns 0.
 *
 * Pure; exported so the discovery-doc centroid projection
 * (TS-053-followup-3) can weight each of a provider's service areas by
 * its extent without re-deriving the geometry.
 */
export function computePolygonAbsoluteArea(polygon: GeoPolygon): number {
  const ring = polygon.coordinates[0];
  if (ring === undefined || ring.length < 4) return 0;

  let signedArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const current = ring[i];
    const next = ring[i + 1];
    if (current === undefined || next === undefined) continue;
    signedArea += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(signedArea * 0.5);
}

/**
 * Collapse a provider's set of service-area polygons into one
 * representative centroid for the discovery doc (TS-053-followup-3).
 *
 * The result is the **area-weighted mean** of the per-area centroids —
 * each area's already-computed centroid contributes in proportion to its
 * polygon's extent, so the largest coverage polygon dominates (a provider
 * with one borough-sized area and one block-sized area lands near the
 * borough). This is the principled blend of the two strategies the task
 * spec names ("centroid of the largest-area polygon, or the mean of
 * per-area centroids"): a single area returns that area's centroid; equal
 * areas return their arithmetic mean.
 *
 * Edge cases:
 *   - Empty set → `null` (the search backend reads a null centroid as
 *     "exclude from distance-sorted queries").
 *   - Every area degenerate (total weight 0) → fall back to the
 *     unweighted mean of the centroids so a zero-area input still yields
 *     a usable point rather than NaN.
 *
 * Pure; takes the materialised record shape (each carries `polygon` +
 * the persisted `centroid`) so callers pass `getServiceAreas(...)` output
 * directly.
 */
export function resolveRepresentativeCentroid(
  areas: ReadonlyArray<{ readonly polygon: GeoPolygon; readonly centroid: GeoCentroid }>,
): GeoCentroid | null {
  if (areas.length === 0) return null;

  let weightedLatitude = 0;
  let weightedLongitude = 0;
  let totalWeight = 0;
  for (const area of areas) {
    const weight = computePolygonAbsoluteArea(area.polygon);
    weightedLatitude += area.centroid.latitude * weight;
    weightedLongitude += area.centroid.longitude * weight;
    totalWeight += weight;
  }

  if (totalWeight > 0) {
    return {
      latitude: round6(weightedLatitude / totalWeight),
      longitude: round6(weightedLongitude / totalWeight),
    };
  }

  // Every polygon was degenerate (zero area) — weighting would divide by
  // zero, so fall back to the unweighted mean of the per-area centroids.
  let sumLatitude = 0;
  let sumLongitude = 0;
  for (const area of areas) {
    sumLatitude += area.centroid.latitude;
    sumLongitude += area.centroid.longitude;
  }
  return {
    latitude: round6(sumLatitude / areas.length),
    longitude: round6(sumLongitude / areas.length),
  };
}
