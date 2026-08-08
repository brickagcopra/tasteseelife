import 'reflect-metadata';

import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import { err } from '../services/result';
import type { ProviderPricingService, ProviderRow } from '../services/provider-pricing.service';

import { ProviderPricingController } from './provider-pricing.controller';

type UpdateReturn = Awaited<ReturnType<ProviderPricingService['updatePricing']>>;

const ROW: ProviderRow = {
  id: 'prov_1',
  userId: 'user_self',
  status: 'active',
  tier: 'certified',
  hourlyRate: '75.00',
  hourlyRateCurrency: 'USD',
  updatedAt: new Date('2026-05-25T12:00:01.000Z'),
  deletedAt: null,
};

interface FakeServiceHandle {
  readonly service: ProviderPricingService;
  readonly capture: { input?: Parameters<ProviderPricingService['updatePricing']>[0] };
}

function makeFakeService(
  response?: UpdateReturn,
  readRow: ProviderRow | null = ROW,
): ProviderPricingService {
  return makeFakeServiceWithCapture(response, readRow).service;
}

function makeFakeServiceWithCapture(
  response?: UpdateReturn,
  readRow: ProviderRow | null = ROW,
): FakeServiceHandle {
  const capture: FakeServiceHandle['capture'] = {};
  const service = {
    updatePricing: async (input: Parameters<ProviderPricingService['updatePricing']>[0]) => {
      capture.input = input;
      return response ?? ({ ok: true, value: ROW } as UpdateReturn);
    },
    getPricing: async () => readRow,
    getPricingByUserId: async () => readRow,
  } as unknown as ProviderPricingService;
  return { service, capture };
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

const VALID_REQUEST = { hourlyRateMinor: 7500, currency: 'USD' };

describe('ProviderPricingController.update', () => {
  it('returns the validated response on a successful update', async () => {
    const ctrl = new ProviderPricingController(makeFakeService());
    const result = await ctrl.update('prov_1', VALID_REQUEST, undefined, reqWithUser());
    expect(result.pricing.providerId).toBe('prov_1');
    expect(result.pricing.tier).toBe('certified');
    expect(result.pricing.hourlyRateMinor).toBe(7500);
    expect(result.pricing.currency).toBe('USD');
    // band for certified is projected from policy.
    expect(result.pricing.band).toEqual({
      tier: 'certified',
      minHourlyRateMinor: 6000,
      maxHourlyRateMinor: 12000,
    });
    expect(result.pricing.updatedAt).toBe('2026-05-25T12:00:01.000Z');
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ProviderPricingController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.update('prov_1', VALID_REQUEST, undefined, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('maps invalid_request → 400', async () => {
    const ctrl = new ProviderPricingController(
      makeFakeService(
        err({ reason: 'invalid_request', message: 'providerId is required' }) as UpdateReturn,
      ),
    );
    await expect(
      ctrl.update('prov_1', VALID_REQUEST, undefined, reqWithUser()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maps not_found → 404', async () => {
    const ctrl = new ProviderPricingController(
      makeFakeService(err({ reason: 'not_found', providerId: 'ghost' }) as UpdateReturn),
    );
    await expect(
      ctrl.update('ghost', VALID_REQUEST, undefined, reqWithUser()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps forbidden → 403', async () => {
    const ctrl = new ProviderPricingController(
      makeFakeService(err({ reason: 'forbidden', providerId: 'prov_1' }) as UpdateReturn),
    );
    await expect(
      ctrl.update('prov_1', VALID_REQUEST, undefined, reqWithUser('user_attacker')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('maps unsupported_currency → 422', async () => {
    const ctrl = new ProviderPricingController(
      makeFakeService(err({ reason: 'unsupported_currency', currency: 'EUR' }) as UpdateReturn),
    );
    try {
      await ctrl.update(
        'prov_1',
        { hourlyRateMinor: 7500, currency: 'EUR' },
        undefined,
        reqWithUser(),
      );
      throw new Error('expected 422 throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(422);
    }
  });

  it('maps out_of_band → 422 carrying the tier band in the body', async () => {
    const ctrl = new ProviderPricingController(
      makeFakeService(
        err({
          reason: 'out_of_band',
          tier: 'certified',
          minHourlyRateMinor: 6000,
          maxHourlyRateMinor: 12000,
          requestedHourlyRateMinor: 5000,
        }) as UpdateReturn,
      ),
    );
    try {
      await ctrl.update(
        'prov_1',
        { hourlyRateMinor: 5000, currency: 'USD' },
        undefined,
        reqWithUser(),
      );
      throw new Error('expected 422 throw');
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      const httpErr = e as HttpException;
      expect(httpErr.getStatus()).toBe(422);
      const body = httpErr.getResponse() as Record<string, unknown>;
      expect(body['tier']).toBe('certified');
      expect(body['minHourlyRateMinor']).toBe(6000);
      expect(body['maxHourlyRateMinor']).toBe(12000);
    }
  });

  it('maps outbox_validation_failed → 500', async () => {
    const ctrl = new ProviderPricingController(
      makeFakeService(
        err({
          reason: 'outbox_validation_failed',
          eventName: 'provider.pricing_updated',
          message: 'payload failed validation',
        }) as UpdateReturn,
      ),
    );
    await expect(
      ctrl.update('prov_1', VALID_REQUEST, undefined, reqWithUser()),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('wears the @Idempotent decorator', () => {
    const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');
    const handler = ProviderPricingController.prototype.update as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, handler)).toBe(true);
  });

  describe('If-Match header handling', () => {
    it('forwards a quoted ISO `If-Match` to the service as a Date', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderPricingController(handle.service);
      await ctrl.update('prov_1', VALID_REQUEST, '"2026-05-25T12:00:01.000Z"', reqWithUser());
      expect(handle.capture.input?.ifMatchUpdatedAt).toBeInstanceOf(Date);
      expect(handle.capture.input?.ifMatchUpdatedAt?.toISOString()).toBe(
        '2026-05-25T12:00:01.000Z',
      );
    });

    it('treats `If-Match: *` as skip-precondition (no Date forwarded)', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderPricingController(handle.service);
      await ctrl.update('prov_1', VALID_REQUEST, '*', reqWithUser());
      expect(handle.capture.input?.ifMatchUpdatedAt).toBeUndefined();
    });

    it('treats an absent `If-Match` as skip-precondition', async () => {
      const handle = makeFakeServiceWithCapture();
      const ctrl = new ProviderPricingController(handle.service);
      await ctrl.update('prov_1', VALID_REQUEST, undefined, reqWithUser());
      expect(handle.capture.input?.ifMatchUpdatedAt).toBeUndefined();
    });

    it('rejects a weak-validator `If-Match` with 400', async () => {
      const ctrl = new ProviderPricingController(makeFakeService());
      await expect(
        ctrl.update('prov_1', VALID_REQUEST, 'W/"2026-05-25T12:00:01.000Z"', reqWithUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-ISO `If-Match` with 400', async () => {
      const ctrl = new ProviderPricingController(makeFakeService());
      await expect(
        ctrl.update('prov_1', VALID_REQUEST, 'not-a-date', reqWithUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maps service precondition_failed → 412 carrying currentUpdatedAt', async () => {
      const currentUpdatedAt = new Date('2026-05-25T12:30:00.000Z');
      const ctrl = new ProviderPricingController(
        makeFakeService(
          err({
            reason: 'precondition_failed',
            providerId: 'prov_1',
            currentUpdatedAt,
          }) as UpdateReturn,
        ),
      );
      try {
        await ctrl.update('prov_1', VALID_REQUEST, '"2026-05-25T12:00:00.000Z"', reqWithUser());
        throw new Error('expected 412 throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const httpErr = e as HttpException;
        expect(httpErr.getStatus()).toBe(412);
        const body = httpErr.getResponse() as Record<string, unknown>;
        expect(body['currentUpdatedAt']).toBe(currentUpdatedAt.toISOString());
      }
    });
  });
});

describe('ProviderPricingController.getMySnapshot', () => {
  it('returns the pricing record projected from the row', async () => {
    const ctrl = new ProviderPricingController(makeFakeService());
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.pricing).not.toBeNull();
    expect(result.pricing?.providerId).toBe('prov_1');
    expect(result.pricing?.hourlyRateMinor).toBe(7500);
    expect(result.pricing?.band.tier).toBe('certified');
  });

  it('returns `{ pricing: null }` when the user has no provider row', async () => {
    const ctrl = new ProviderPricingController(makeFakeService(undefined, null));
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.pricing).toBeNull();
  });

  it('projects null rate + currency when the provider has not set a rate', async () => {
    const noRate: ProviderRow = { ...ROW, hourlyRate: null, hourlyRateCurrency: null };
    const ctrl = new ProviderPricingController(makeFakeService(undefined, noRate));
    const result = await ctrl.getMySnapshot(reqWithUser());
    expect(result.pricing?.hourlyRateMinor).toBeNull();
    expect(result.pricing?.currency).toBeNull();
    // band still resolved from the tier so the editor can render the range.
    expect(result.pricing?.band.tier).toBe('certified');
  });

  it('throws 401 when no requestContext is attached', async () => {
    const ctrl = new ProviderPricingController(makeFakeService());
    const req = { header: () => undefined } as unknown as RequestWithContext;
    await expect(ctrl.getMySnapshot(req)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('ProviderPricingController.getById', () => {
  it('returns the bare pricing record (no wrapper) on hit', async () => {
    const ctrl = new ProviderPricingController(makeFakeService());
    const result = await ctrl.getById('prov_1', reqWithUser('user_observer'));
    expect(result.providerId).toBe('prov_1');
    expect(result.hourlyRateMinor).toBe(7500);
  });

  it('throws 404 when the provider does not exist', async () => {
    const ctrl = new ProviderPricingController(makeFakeService(undefined, null));
    await expect(ctrl.getById('ghost', reqWithUser())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 404 when the provider row is soft-deleted', async () => {
    const softDeleted: ProviderRow = { ...ROW, deletedAt: new Date('2026-05-25T12:00:02.000Z') };
    const ctrl = new ProviderPricingController(makeFakeService(undefined, softDeleted));
    await expect(ctrl.getById('prov_1', reqWithUser())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does NOT wear @Idempotent (read endpoint)', () => {
    const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');
    const handler = ProviderPricingController.prototype.getById as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, handler)).toBeUndefined();
  });
});
