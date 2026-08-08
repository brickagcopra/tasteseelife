import { describe, expect, it } from 'vitest';

import {
  DeleteProviderServiceAreasResponseSchema,
  GeoBoundingBoxSchema,
  GeoCentroidSchema,
  GeoLinearRingSchema,
  GeoPolygonSchema,
  GeoPositionSchema,
  geoPolygonApproxAreaSqKm,
  geoRingIsSimple,
  geoRingSignedAreaDeg2,
  PROVIDER_SERVICE_AREAS_MAX,
  PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH,
  PROVIDER_SERVICE_AREA_MAX_AREA_SQ_KM,
  PROVIDER_SERVICE_AREA_RING_VERTICES_MAX,
  ProviderServiceAreaInputSchema,
  ProviderServiceAreaRecordSchema,
  ProviderServiceAreasSnapshotResponseSchema,
  UpdateProviderServiceAreasRequestSchema,
  UpdateProviderServiceAreasResponseSchema,
} from '../http/provider-service-area.schema';
import type { GeoPolygon, GeoPosition } from '../http/provider-service-area.schema';

// A closed square ring over Manhattan's Upper East Side (5 positions —
// 4 corners + the closing repeat). GeoJSON order is [longitude, latitude].
// Wound counterclockwise (BL → BR → TR → TL → close) so it is a valid
// RFC 7946 exterior ring.
const closedSquareRing: GeoPosition[] = [
  [-73.96, 40.77],
  [-73.95, 40.77],
  [-73.95, 40.78],
  [-73.96, 40.78],
  [-73.96, 40.77],
];

const validPolygon = {
  type: 'Polygon' as const,
  coordinates: [closedSquareRing],
};

// ─── Geometric-validity fixtures (TS-202-followup-3) ────────────────────

/** The same UES square wound CLOCKWISE — an invalid exterior ring. */
const cwSquareRing: GeoPosition[] = [
  [-73.96, 40.77],
  [-73.96, 40.78],
  [-73.95, 40.78],
  [-73.95, 40.77],
  [-73.96, 40.77],
];

/**
 * A self-intersecting ring with a deliberately ASYMMETRIC, non-zero
 * signed area (≈ +40 deg²) so the geometry reaches the simplicity check
 * rather than short-circuiting on the zero-area degenerate guard (a
 * symmetric 4-vertex bowtie has zero net area). Two non-adjacent edges
 * cross near (5.8, 0).
 */
const selfIntersectingRing: GeoPosition[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [5, -2],
  [0, 10],
  [0, 0],
];

/** A symmetric 4-vertex bowtie (zero net area) — used for the simplicity helper. */
const symmetricBowtieRing: GeoPosition[] = [
  [0, 0],
  [10, 0],
  [0, 10],
  [10, 10],
  [0, 0],
];

/** Three collinear points + the closing repeat — degenerate, zero area. */
const collinearRing: GeoPosition[] = [
  [0, 0],
  [1, 1],
  [2, 2],
  [0, 0],
];

/** A 4°×4° square (~145,000 km²) — well over the area cap. CCW. */
const oversizedSquareRing: GeoPosition[] = [
  [-73.96, 40.77],
  [-69.96, 40.77],
  [-69.96, 44.77],
  [-73.96, 44.77],
  [-73.96, 40.77],
];

/** A 1°×1° square (~9,300 km²) — large but comfortably under the cap. CCW. */
const largeUnderCapSquareRing: GeoPosition[] = [
  [-73.96, 40.77],
  [-72.96, 40.77],
  [-72.96, 41.77],
  [-73.96, 41.77],
  [-73.96, 40.77],
];

const polygonOf = (...rings: GeoPosition[][]): GeoPolygon => ({
  type: 'Polygon',
  coordinates: rings,
});

describe('GeoPositionSchema', () => {
  it('accepts a [longitude, latitude] pair', () => {
    expect(GeoPositionSchema.safeParse([-73.96, 40.77]).success).toBe(true);
  });

  it('rejects out-of-range longitude', () => {
    expect(GeoPositionSchema.safeParse([-181, 40]).success).toBe(false);
  });

  it('rejects out-of-range latitude', () => {
    expect(GeoPositionSchema.safeParse([0, 91]).success).toBe(false);
  });

  it('rejects a 3-element (altitude) position', () => {
    expect(GeoPositionSchema.safeParse([-73.96, 40.77, 12]).success).toBe(false);
  });

  it('rejects a 1-element position', () => {
    expect(GeoPositionSchema.safeParse([-73.96]).success).toBe(false);
  });
});

describe('GeoLinearRingSchema', () => {
  it('accepts a closed ring of at least 4 positions', () => {
    expect(GeoLinearRingSchema.safeParse(closedSquareRing).success).toBe(true);
  });

  it('rejects a ring under 4 positions', () => {
    expect(
      GeoLinearRingSchema.safeParse([
        [-73.96, 40.77],
        [-73.95, 40.77],
        [-73.96, 40.77],
      ]).success,
    ).toBe(false);
  });

  it('rejects an unclosed ring (first !== last)', () => {
    expect(
      GeoLinearRingSchema.safeParse([
        [-73.96, 40.77],
        [-73.95, 40.77],
        [-73.95, 40.78],
        [-73.96, 40.78],
      ]).success,
    ).toBe(false);
  });

  it('rejects a ring over the vertex cap', () => {
    const tooMany = Array.from({ length: PROVIDER_SERVICE_AREA_RING_VERTICES_MAX + 1 }, () => [
      -73.96, 40.77,
    ]);
    expect(GeoLinearRingSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('GeoPolygonSchema', () => {
  it('accepts a single-ring polygon', () => {
    expect(GeoPolygonSchema.safeParse(validPolygon).success).toBe(true);
  });

  it('accepts a polygon with a hole (two rings)', () => {
    // RFC 7946 §3.1.6: the exterior ring winds CCW, holes wind CW. This
    // hole is the reverse-order (clockwise) traversal of the same square.
    const hole = [
      [-73.958, 40.772],
      [-73.958, 40.778],
      [-73.952, 40.778],
      [-73.952, 40.772],
      [-73.958, 40.772],
    ];
    expect(
      GeoPolygonSchema.safeParse({
        type: 'Polygon',
        coordinates: [closedSquareRing, hole],
      }).success,
    ).toBe(true);
  });

  it('rejects a wrong `type` literal', () => {
    expect(
      GeoPolygonSchema.safeParse({ type: 'MultiPolygon', coordinates: [closedSquareRing] }).success,
    ).toBe(false);
  });

  it('rejects an empty coordinates array (no exterior ring)', () => {
    expect(GeoPolygonSchema.safeParse({ type: 'Polygon', coordinates: [] }).success).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(GeoPolygonSchema.safeParse({ ...validPolygon, bbox: [0, 0, 1, 1] }).success).toBe(false);
  });
});

describe('GeoCentroidSchema / GeoBoundingBoxSchema', () => {
  it('accepts a valid centroid', () => {
    expect(GeoCentroidSchema.safeParse({ latitude: 40.775, longitude: -73.955 }).success).toBe(
      true,
    );
  });

  it('rejects a centroid with GeoJSON tuple shape', () => {
    expect(GeoCentroidSchema.safeParse([-73.955, 40.775]).success).toBe(false);
  });

  it('accepts a valid bounding box', () => {
    expect(
      GeoBoundingBoxSchema.safeParse({
        minLatitude: 40.77,
        minLongitude: -73.96,
        maxLatitude: 40.78,
        maxLongitude: -73.95,
      }).success,
    ).toBe(true);
  });

  it('rejects a bounding box missing a corner', () => {
    expect(
      GeoBoundingBoxSchema.safeParse({
        minLatitude: 40.77,
        minLongitude: -73.96,
        maxLatitude: 40.78,
      }).success,
    ).toBe(false);
  });
});

describe('ProviderServiceAreaInputSchema', () => {
  it('accepts a labelled area', () => {
    expect(
      ProviderServiceAreaInputSchema.safeParse({
        label: 'Upper East Side',
        polygon: validPolygon,
      }).success,
    ).toBe(true);
  });

  it('accepts an omitted label', () => {
    expect(ProviderServiceAreaInputSchema.safeParse({ polygon: validPolygon }).success).toBe(true);
  });

  it('accepts a null label', () => {
    expect(
      ProviderServiceAreaInputSchema.safeParse({ label: null, polygon: validPolygon }).success,
    ).toBe(true);
  });

  it('rejects an over-long label', () => {
    expect(
      ProviderServiceAreaInputSchema.safeParse({
        label: 'x'.repeat(PROVIDER_SERVICE_AREA_LABEL_MAX_LENGTH + 1),
        polygon: validPolygon,
      }).success,
    ).toBe(false);
  });

  it('rejects a missing polygon', () => {
    expect(ProviderServiceAreaInputSchema.safeParse({ label: 'UES' }).success).toBe(false);
  });

  it('rejects a client-supplied centroid (unknown field)', () => {
    expect(
      ProviderServiceAreaInputSchema.safeParse({
        polygon: validPolygon,
        centroid: { latitude: 40.775, longitude: -73.955 },
      }).success,
    ).toBe(false);
  });
});

describe('ProviderServiceAreaRecordSchema', () => {
  const validRecord = {
    id: 'psa_1',
    providerId: 'prov_abc',
    label: 'Upper East Side',
    polygon: validPolygon,
    centroid: { latitude: 40.775, longitude: -73.955 },
    boundingBox: {
      minLatitude: 40.77,
      minLongitude: -73.96,
      maxLatitude: 40.78,
      maxLongitude: -73.95,
    },
    createdAt: '2026-05-25T12:00:00.000Z',
    updatedAt: '2026-05-25T12:00:00.000Z',
  };

  it('accepts a valid record', () => {
    expect(ProviderServiceAreaRecordSchema.safeParse(validRecord).success).toBe(true);
  });

  it('accepts a null label', () => {
    expect(ProviderServiceAreaRecordSchema.safeParse({ ...validRecord, label: null }).success).toBe(
      true,
    );
  });

  it('rejects a non-ISO createdAt', () => {
    expect(
      ProviderServiceAreaRecordSchema.safeParse({ ...validRecord, createdAt: 'today' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      ProviderServiceAreaRecordSchema.safeParse({ ...validRecord, extra: 'oops' }).success,
    ).toBe(false);
  });
});

describe('ProviderServiceAreasSnapshotResponseSchema', () => {
  it('accepts a null snapshot (no provider row)', () => {
    expect(
      ProviderServiceAreasSnapshotResponseSchema.safeParse({
        providerId: null,
        serviceAreas: null,
      }).success,
    ).toBe(true);
  });

  it('accepts an empty serviceAreas array carrying the providerId (provider, no areas)', () => {
    expect(
      ProviderServiceAreasSnapshotResponseSchema.safeParse({
        providerId: 'prov_abc',
        serviceAreas: [],
      }).success,
    ).toBe(true);
  });

  it('rejects a missing providerId field (`.strict()`)', () => {
    expect(ProviderServiceAreasSnapshotResponseSchema.safeParse({ serviceAreas: [] }).success).toBe(
      false,
    );
  });
});

describe('UpdateProviderServiceAreasRequestSchema', () => {
  it('accepts a single area', () => {
    expect(
      UpdateProviderServiceAreasRequestSchema.safeParse({
        serviceAreas: [{ label: 'UES', polygon: validPolygon }],
      }).success,
    ).toBe(true);
  });

  it('accepts an empty array (clear)', () => {
    expect(UpdateProviderServiceAreasRequestSchema.safeParse({ serviceAreas: [] }).success).toBe(
      true,
    );
  });

  it('rejects more than the per-provider area cap', () => {
    const tooMany = Array.from({ length: PROVIDER_SERVICE_AREAS_MAX + 1 }, () => ({
      polygon: validPolygon,
    }));
    expect(
      UpdateProviderServiceAreasRequestSchema.safeParse({ serviceAreas: tooMany }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (`.strict()`)', () => {
    expect(
      UpdateProviderServiceAreasRequestSchema.safeParse({
        serviceAreas: [{ polygon: validPolygon }],
        extra: 'oops',
      }).success,
    ).toBe(false);
  });

  it('rejects an area with a malformed (unclosed) polygon ring', () => {
    expect(
      UpdateProviderServiceAreasRequestSchema.safeParse({
        serviceAreas: [
          {
            polygon: {
              type: 'Polygon',
              coordinates: [
                [
                  [-73.96, 40.77],
                  [-73.95, 40.77],
                  [-73.95, 40.78],
                ],
              ],
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('UpdateProviderServiceAreasResponseSchema / DeleteProviderServiceAreasResponseSchema', () => {
  it('accepts a wrapped record list', () => {
    expect(
      UpdateProviderServiceAreasResponseSchema.safeParse({
        serviceAreas: [
          {
            id: 'psa_1',
            providerId: 'prov_abc',
            label: null,
            polygon: validPolygon,
            centroid: { latitude: 40.775, longitude: -73.955 },
            boundingBox: {
              minLatitude: 40.77,
              minLongitude: -73.96,
              maxLatitude: 40.78,
              maxLongitude: -73.95,
            },
            createdAt: '2026-05-25T12:00:00.000Z',
            updatedAt: '2026-05-25T12:00:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('accepts a delete response with a nonnegative count', () => {
    expect(
      DeleteProviderServiceAreasResponseSchema.safeParse({
        providerId: 'prov_abc',
        deletedCount: 2,
      }).success,
    ).toBe(true);
  });

  it('rejects a negative delete count', () => {
    expect(
      DeleteProviderServiceAreasResponseSchema.safeParse({
        providerId: 'prov_abc',
        deletedCount: -1,
      }).success,
    ).toBe(false);
  });
});

describe('GeoPolygonSchema geometric validity (TS-202-followup-3)', () => {
  /** Collect every custom-issue message from a failed parse for assertions. */
  function issueMessages(value: unknown): string[] {
    const result = GeoPolygonSchema.safeParse(value);
    return result.success ? [] : result.error.issues.map((i) => i.message);
  }

  it('accepts a CCW exterior square', () => {
    expect(GeoPolygonSchema.safeParse(polygonOf(closedSquareRing)).success).toBe(true);
  });

  it('accepts a CCW exterior with a CW hole (RFC 7946 right-hand rule)', () => {
    const cwHole: GeoPosition[] = [
      [-73.958, 40.772],
      [-73.958, 40.778],
      [-73.952, 40.778],
      [-73.952, 40.772],
      [-73.958, 40.772],
    ];
    expect(GeoPolygonSchema.safeParse(polygonOf(closedSquareRing, cwHole)).success).toBe(true);
  });

  it('rejects a clockwise exterior ring with a winding message', () => {
    const messages = issueMessages(polygonOf(cwSquareRing));
    expect(messages.some((m) => m.includes('counterclockwise'))).toBe(true);
  });

  it('rejects a counterclockwise hole (holes must wind clockwise)', () => {
    // The exterior is valid CCW; the hole reuses the CCW square winding.
    const ccwHole: GeoPosition[] = [
      [-73.958, 40.772],
      [-73.952, 40.772],
      [-73.952, 40.778],
      [-73.958, 40.778],
      [-73.958, 40.772],
    ];
    const messages = issueMessages(polygonOf(closedSquareRing, ccwHole));
    expect(messages.some((m) => m.includes('clockwise'))).toBe(true);
  });

  it('rejects a self-intersecting exterior ring', () => {
    const messages = issueMessages(polygonOf(selfIntersectingRing));
    expect(messages.some((m) => m.includes('self-intersecting'))).toBe(true);
  });

  it('rejects a degenerate (collinear, zero-area) ring', () => {
    const messages = issueMessages(polygonOf(collinearRing));
    expect(messages.some((m) => m.includes('degenerate'))).toBe(true);
  });

  it('rejects a polygon whose area exceeds the cap', () => {
    const messages = issueMessages(polygonOf(oversizedSquareRing));
    expect(messages.some((m) => m.includes('exceeds the cap'))).toBe(true);
  });

  it('accepts a large polygon that stays under the area cap', () => {
    expect(GeoPolygonSchema.safeParse(polygonOf(largeUnderCapSquareRing)).success).toBe(true);
  });

  it('rejects the oversized polygon through the full PUT request schema', () => {
    expect(
      UpdateProviderServiceAreasRequestSchema.safeParse({
        serviceAreas: [{ polygon: polygonOf(oversizedSquareRing) }],
      }).success,
    ).toBe(false);
  });
});

describe('geo geometry helpers (TS-202-followup-3)', () => {
  describe('geoRingSignedAreaDeg2', () => {
    it('is positive for a counterclockwise ring', () => {
      expect(geoRingSignedAreaDeg2(closedSquareRing)).toBeGreaterThan(0);
    });

    it('is negative for a clockwise ring', () => {
      expect(geoRingSignedAreaDeg2(cwSquareRing)).toBeLessThan(0);
    });

    it('is zero for a collinear (degenerate) ring', () => {
      expect(geoRingSignedAreaDeg2(collinearRing)).toBe(0);
    });

    it('negates exactly when the ring is reversed', () => {
      const forward = geoRingSignedAreaDeg2(closedSquareRing);
      const reversed = geoRingSignedAreaDeg2([...closedSquareRing].reverse());
      expect(reversed).toBeCloseTo(-forward, 10);
    });
  });

  describe('geoRingIsSimple', () => {
    it('returns true for a simple square', () => {
      expect(geoRingIsSimple(closedSquareRing)).toBe(true);
    });

    it('returns false for an asymmetric self-intersecting ring', () => {
      expect(geoRingIsSimple(selfIntersectingRing)).toBe(false);
    });

    it('returns false for a symmetric (zero-area) bowtie', () => {
      expect(geoRingIsSimple(symmetricBowtieRing)).toBe(false);
    });
  });

  describe('geoPolygonApproxAreaSqKm', () => {
    it('approximates a ~1 km² UES square within a sane range', () => {
      const area = geoPolygonApproxAreaSqKm(polygonOf(closedSquareRing));
      expect(area).toBeGreaterThan(0.5);
      expect(area).toBeLessThan(2);
    });

    it('subtracts a hole from the exterior area', () => {
      const cwHole: GeoPosition[] = [
        [-73.958, 40.772],
        [-73.958, 40.778],
        [-73.952, 40.778],
        [-73.952, 40.772],
        [-73.958, 40.772],
      ];
      const withHole = geoPolygonApproxAreaSqKm(polygonOf(closedSquareRing, cwHole));
      const withoutHole = geoPolygonApproxAreaSqKm(polygonOf(closedSquareRing));
      expect(withHole).toBeGreaterThan(0);
      expect(withHole).toBeLessThan(withoutHole);
    });

    it('reports the oversized square above the cap', () => {
      expect(geoPolygonApproxAreaSqKm(polygonOf(oversizedSquareRing))).toBeGreaterThan(
        PROVIDER_SERVICE_AREA_MAX_AREA_SQ_KM,
      );
    });

    it('reports the under-cap square below the cap', () => {
      expect(geoPolygonApproxAreaSqKm(polygonOf(largeUnderCapSquareRing))).toBeLessThan(
        PROVIDER_SERVICE_AREA_MAX_AREA_SQ_KM,
      );
    });
  });
});
