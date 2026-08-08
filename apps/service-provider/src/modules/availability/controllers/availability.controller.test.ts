import 'reflect-metadata';

import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import { err, ok } from '../services/result';
import type {
  AvailabilityService,
  DeleteAvailabilityOutcome,
  ProviderAvailabilitySnapshot,
} from '../services/availability.service';

import { AvailabilityController } from './availability.controller';

type UpdateReturn = Awaited<ReturnType<AvailabilityService['updateAvailability']>>;
type DeleteReturn = Awaited<ReturnType<AvailabilityService['deleteAvailability']>>;

const NOW = new Date('2026-05-20T12:00:00.000Z');

const SNAPSHOT: ProviderAvailabilitySnapshot = {
  providerId: 'prov_1',
  timeZone: 'America/New_York',
  windows: [
    { weekday: 'monday', startTime: '09:00', endTime: '13:00' },
    { weekday: 'wednesday', startTime: '18:00', endTime: '21:00' },
  ],
  exceptions: [{ date: '2026-12-25' }],
  updatedAt: NOW,
};

const DELETE_OUTCOME: DeleteAvailabilityOutcome = {
  providerId: 'prov_1',
  deletedWindowCount: 2,
  deletedExceptionCount: 1,
};

function makeFakeService(
  input: {
    updateReturn?: UpdateReturn;
    deleteReturn?: DeleteReturn;
    snapshot?: ProviderAvailabilitySnapshot | null;
  } = {},
): AvailabilityService {
  return {
    updateAvailability: async () => input.updateReturn ?? (ok(SNAPSHOT) as UpdateReturn),
    deleteAvailability: async () => input.deleteReturn ?? (ok(DELETE_OUTCOME) as DeleteReturn),
    getAvailability: async () => input.snapshot ?? SNAPSHOT,
    getAvailabilityByUserId: async () => (input.snapshot === undefined ? SNAPSHOT : input.snapshot),
  } as unknown as AvailabilityService;
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
  windows: [
    { weekday: 'monday' as const, startTime: '09:00', endTime: '13:00' },
    { weekday: 'wednesday' as const, startTime: '18:00', endTime: '21:00' },
  ],
  exceptions: [{ date: '2026-12-25' }],
};

describe('AvailabilityController.getMySnapshot', () => {
  it('returns the snapshot for an authenticated user', async () => {
    const ctrl = new AvailabilityController(makeFakeService());
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.availability?.providerId).toBe('prov_1');
    expect(result.availability?.windows).toHaveLength(2);
    expect(result.availability?.exceptions).toEqual([{ date: '2026-12-25' }]);
  });

  it('returns `{ availability: null }` when the user has no provider row yet', async () => {
    const ctrl = new AvailabilityController(makeFakeService({ snapshot: null }));
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.availability).toBeNull();
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new AvailabilityController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.getMySnapshot(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AvailabilityController.updateAvailability', () => {
  it('returns the validated response on a successful update', async () => {
    const ctrl = new AvailabilityController(makeFakeService());
    const result = await ctrl.updateAvailability('prov_1', VALID_REQUEST, reqWithUser());
    expect(result.availability.providerId).toBe('prov_1');
    expect(result.availability.windows).toHaveLength(2);
    expect(result.availability.exceptions).toEqual([{ date: '2026-12-25' }]);
    expect(result.availability.updatedAt).toBe(NOW.toISOString());
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new AvailabilityController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.updateAvailability('prov_1', VALID_REQUEST, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps invalid_request → 400', async () => {
    const ctrl = new AvailabilityController(
      makeFakeService({
        updateReturn: err({
          reason: 'invalid_request',
          message: 'providerId is required',
        }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateAvailability('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps not_found → 404', async () => {
    const ctrl = new AvailabilityController(
      makeFakeService({
        updateReturn: err({
          reason: 'not_found',
          providerId: 'prov_missing',
        }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateAvailability('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps forbidden → 403', async () => {
    const ctrl = new AvailabilityController(
      makeFakeService({
        updateReturn: err({ reason: 'forbidden', providerId: 'prov_1' }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateAvailability('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps outbox_validation_failed → 500', async () => {
    const ctrl = new AvailabilityController(
      makeFakeService({
        updateReturn: err({
          reason: 'outbox_validation_failed',
          eventName: 'provider.availability_updated',
          message: 'payload validation failed',
        }) as UpdateReturn,
      }),
    );
    await expect(
      ctrl.updateAvailability('prov_1', VALID_REQUEST, reqWithUser()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});

describe('AvailabilityController.deleteAvailability', () => {
  it('returns the deletion counts on success', async () => {
    const ctrl = new AvailabilityController(makeFakeService());
    const result = await ctrl.deleteAvailability('prov_1', reqWithUser());
    expect(result.providerId).toBe('prov_1');
    expect(result.deletedWindowCount).toBe(2);
    expect(result.deletedExceptionCount).toBe(1);
  });

  it('returns zero counts on no-op (empty schedule)', async () => {
    const ctrl = new AvailabilityController(
      makeFakeService({
        deleteReturn: ok({
          providerId: 'prov_1',
          deletedWindowCount: 0,
          deletedExceptionCount: 0,
        }) as DeleteReturn,
      }),
    );
    const result = await ctrl.deleteAvailability('prov_1', reqWithUser());
    expect(result.deletedWindowCount).toBe(0);
    expect(result.deletedExceptionCount).toBe(0);
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new AvailabilityController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.deleteAvailability('prov_1', req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps forbidden → 403', async () => {
    const ctrl = new AvailabilityController(
      makeFakeService({
        deleteReturn: err({ reason: 'forbidden', providerId: 'prov_1' }) as DeleteReturn,
      }),
    );
    await expect(ctrl.deleteAvailability('prov_1', reqWithUser())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('maps not_found → 404', async () => {
    const ctrl = new AvailabilityController(
      makeFakeService({
        deleteReturn: err({
          reason: 'not_found',
          providerId: 'prov_missing',
        }) as DeleteReturn,
      }),
    );
    await expect(ctrl.deleteAvailability('prov_1', reqWithUser())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
