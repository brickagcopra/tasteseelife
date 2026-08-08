import 'reflect-metadata';

import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { GeoPolygon, ProviderServiceAreaRecord } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import { err, ok } from '../services/result';
import type {
  DeleteServiceAreasOutcome,
  ServiceAreasService,
} from '../services/service-areas.service';

import { ServiceAreasController } from './service-areas.controller';

type UpdateReturn = Awaited<ReturnType<ServiceAreasService['updateServiceAreas']>>;
type DeleteReturn = Awaited<ReturnType<ServiceAreasService['deleteServiceAreas']>>;

const NOW = new Date('2026-05-25T12:00:00.000Z');

const uesPolygon: GeoPolygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-73.96, 40.77],
      [-73.95, 40.77],
      [-73.95, 40.78],
      [-73.96, 40.78],
      [-73.96, 40.77],
    ],
  ],
};

const RECORD: ProviderServiceAreaRecord = {
  id: 'psa_1',
  providerId: 'prov_1',
  label: 'Upper East Side',
  polygon: uesPolygon,
  centroid: { latitude: 40.775, longitude: -73.955 },
  boundingBox: {
    minLatitude: 40.77,
    minLongitude: -73.96,
    maxLatitude: 40.78,
    maxLongitude: -73.95,
  },
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

const DELETE_OUTCOME: DeleteServiceAreasOutcome = {
  providerId: 'prov_1',
  deletedCount: 2,
};

function makeFakeService(
  input: {
    updateReturn?: UpdateReturn;
    deleteReturn?: DeleteReturn;
    records?: ProviderServiceAreaRecord[] | null;
  } = {},
): ServiceAreasService {
  const records = input.records === undefined ? [RECORD] : input.records;
  return {
    updateServiceAreas: async () => input.updateReturn ?? (ok([RECORD]) as UpdateReturn),
    deleteServiceAreas: async () => input.deleteReturn ?? (ok(DELETE_OUTCOME) as DeleteReturn),
    getServiceAreas: async () => records,
    getServiceAreasByUserId: async () =>
      records === null ? null : { providerId: 'prov_1', serviceAreas: records },
  } as unknown as ServiceAreasService;
}

function reqWithUser(userId = 'user_self'): RequestWithContext {
  return {
    requestContext: {
      userId,
      sessionId: 'sid_1',
      mfa: false,
      roles: [],
      tenantScope: { type: 'global' },
    },
    header: () => undefined,
  } as unknown as RequestWithContext;
}

const VALID_REQUEST = {
  serviceAreas: [{ label: 'Upper East Side', polygon: uesPolygon }],
};

describe('ServiceAreasController.getMySnapshot', () => {
  it('returns the snapshot for an authenticated user', async () => {
    const ctrl = new ServiceAreasController(makeFakeService());
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.serviceAreas).toHaveLength(1);
    expect(result.serviceAreas?.[0]?.providerId).toBe('prov_1');
    expect(result.serviceAreas?.[0]?.polygon).toEqual(uesPolygon);
  });

  it('returns `{ serviceAreas: [] }` for a provider with no areas', async () => {
    const ctrl = new ServiceAreasController(makeFakeService({ records: [] }));
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.serviceAreas).toEqual([]);
  });

  it('returns `{ serviceAreas: null }` when the user has no provider row yet', async () => {
    const ctrl = new ServiceAreasController(makeFakeService({ records: null }));
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.serviceAreas).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ServiceAreasController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.getMySnapshot(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ServiceAreasController.updateServiceAreas', () => {
  it('returns the validated response on a successful update', async () => {
    const ctrl = new ServiceAreasController(makeFakeService());
    const result = await ctrl.updateServiceAreas('prov_1', VALID_REQUEST, reqWithUser());
    expect(result.serviceAreas).toHaveLength(1);
    expect(result.serviceAreas[0]?.providerId).toBe('prov_1');
    expect(result.serviceAreas[0]?.centroid).toEqual({ latitude: 40.775, longitude: -73.955 });
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ServiceAreasController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.updateServiceAreas('prov_1', VALID_REQUEST, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps invalid_request → 400', async () => {
    const ctrl = new ServiceAreasController(
      makeFakeService({
        updateReturn: err({
          reason: 'invalid_request',
          message: 'providerId is required',
        }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateServiceAreas('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps not_found → 404', async () => {
    const ctrl = new ServiceAreasController(
      makeFakeService({
        updateReturn: err({
          reason: 'not_found',
          providerId: 'prov_missing',
        }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateServiceAreas('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps forbidden → 403', async () => {
    const ctrl = new ServiceAreasController(
      makeFakeService({
        updateReturn: err({ reason: 'forbidden', providerId: 'prov_1' }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateServiceAreas('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps outbox_validation_failed → 500', async () => {
    const ctrl = new ServiceAreasController(
      makeFakeService({
        updateReturn: err({
          reason: 'outbox_validation_failed',
          eventName: 'provider.service_areas_updated',
          message: 'payload validation failed',
        }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateServiceAreas('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('ServiceAreasController.deleteServiceAreas', () => {
  it('returns the deletion count on success', async () => {
    const ctrl = new ServiceAreasController(makeFakeService());
    const result = await ctrl.deleteServiceAreas('prov_1', reqWithUser());
    expect(result.providerId).toBe('prov_1');
    expect(result.deletedCount).toBe(2);
  });

  it('returns zero count on no-op (empty set)', async () => {
    const ctrl = new ServiceAreasController(
      makeFakeService({
        deleteReturn: ok({ providerId: 'prov_1', deletedCount: 0 }) as DeleteReturn,
      }),
    );
    const result = await ctrl.deleteServiceAreas('prov_1', reqWithUser());
    expect(result.deletedCount).toBe(0);
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ServiceAreasController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.deleteServiceAreas('prov_1', req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps forbidden → 403', async () => {
    const ctrl = new ServiceAreasController(
      makeFakeService({
        deleteReturn: err({ reason: 'forbidden', providerId: 'prov_1' }) as DeleteReturn,
      }),
    );
    await expect(ctrl.deleteServiceAreas('prov_1', reqWithUser())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('maps not_found → 404', async () => {
    const ctrl = new ServiceAreasController(
      makeFakeService({
        deleteReturn: err({
          reason: 'not_found',
          providerId: 'prov_missing',
        }) as DeleteReturn,
      }),
    );
    await expect(ctrl.deleteServiceAreas('prov_1', reqWithUser())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
