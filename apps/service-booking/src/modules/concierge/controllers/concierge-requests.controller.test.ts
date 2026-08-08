import 'reflect-metadata';

import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { RequestWithContext } from '@taste-and-see/nest-auth';

import { err, ok } from '../../../common/result';
import type {
  BookingRecord,
  BookingsServiceFailure,
} from '../../bookings/services/bookings.service';
import type { ConciergeRequestsService } from '../services/concierge-requests.service';
import { ConciergeRequestsController } from './concierge-requests.controller';

/**
 * Controller-level wiring + failure-mapping assertions for
 * `ConciergeRequestsController` (TS-125). Service-layer behavioural
 * coverage lives in `services/concierge-requests.service.test.ts`. This
 * file pins the metadata wiring so a refactor that drops
 * `@Idempotent()` from the POST handler fails here before reaching
 * production, and confirms the discriminated-union failure mapping
 * lands at the right HTTP status code.
 */

const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

const validBody = {
  householdId: 'hh_abc',
  seniorId: 'snr_abc',
  providerId: 'prv_abc',
  serviceKind: 'companion_dining' as const,
  scheduledStart: '2026-06-10T17:00:00.000Z',
  scheduledEnd: '2026-06-10T19:00:00.000Z',
};

function makeReq(userId: string | null): RequestWithContext {
  return {
    headers: {},
    requestContext:
      userId === null
        ? undefined
        : {
            userId,
            mfaVerified: true,
            roles: [],
            tenantScope: { type: 'global' },
            sessionId: 'sess_test',
          },
  } as unknown as RequestWithContext;
}

function makeRow(): BookingRecord {
  return {
    id: 'bkg_fake_1',
    householdId: validBody.householdId,
    seniorId: validBody.seniorId,
    providerId: validBody.providerId,
    serviceKind: 'companion_dining',
    status: 'pending',
    scheduledStart: new Date(validBody.scheduledStart),
    scheduledEnd: new Date(validBody.scheduledEnd),
    currency: 'USD',
    basePrice: { toString: () => '150.00' },
    commissionRate: { toString: () => '0.2000' },
    commissionAmount: { toString: () => '30.00' },
    finalPrice: { toString: () => '150.00' },
    bookingNotes: null,
    completedAt: null,
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    acceptWindowExpiresAt: new Date('2026-05-13T12:30:00.000Z'),
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    heldByIncidentId: null,
    createdAt: new Date('2026-05-13T12:00:00.000Z'),
    updatedAt: new Date('2026-05-13T12:00:00.000Z'),
  };
}

describe('ConciergeRequestsController route + idempotency wiring', () => {
  it('marks POST handler with @Idempotent()', () => {
    const handler = ConciergeRequestsController.prototype.create as unknown as object;
    const flag = Reflect.getMetadata(IDEMPOTENT_METADATA, handler) as unknown;
    expect(flag).toBe(true);
  });

  it('routes create at POST api/v1/bookings/concierge-request', () => {
    const handler = ConciergeRequestsController.prototype.create as unknown as object;
    const path = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
    expect(path).toBe('api/v1/bookings/concierge-request');
    expect(method).toBe(RequestMethod.POST);
  });
});

describe('ConciergeRequestsController.create', () => {
  it('throws Unauthorized when no requestContext is attached', async () => {
    const requests = {
      createRequest: vi.fn(),
    } as unknown as ConciergeRequestsService;
    const controller = new ConciergeRequestsController(requests);
    await expect(controller.create(validBody, makeReq(null))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('returns the BookingResponse on success', async () => {
    const requests = {
      createRequest: vi.fn().mockResolvedValueOnce(ok(makeRow())),
    } as unknown as ConciergeRequestsService;
    const controller = new ConciergeRequestsController(requests);
    const response = await controller.create(validBody, makeReq('usr_actor'));
    expect(response.id).toBe('bkg_fake_1');
    expect(response.status).toBe('pending');
    expect(response.basePriceMinor).toBe(15_000);
    expect(response.commissionRateBps).toBe(2_000);
  });

  it('maps tier_gating_violation to a 409 Conflict', async () => {
    const failure: BookingsServiceFailure = {
      reason: 'tier_gating_violation',
      violationReason: 'tier_3_requires_elite',
      householdTier: 'tier_3_concierge',
      providerTier: 'certified',
    };
    const requests = {
      createRequest: vi.fn().mockResolvedValueOnce(err(failure)),
    } as unknown as ConciergeRequestsService;
    const controller = new ConciergeRequestsController(requests);
    await expect(controller.create(validBody, makeReq('usr_actor'))).rejects.toMatchObject({
      status: 409,
    });
  });

  it('maps outbox_validation_failed to a 500', async () => {
    const failure: BookingsServiceFailure = {
      reason: 'outbox_validation_failed',
      message: 'broken',
    };
    const requests = {
      createRequest: vi.fn().mockResolvedValueOnce(err(failure)),
    } as unknown as ConciergeRequestsService;
    const controller = new ConciergeRequestsController(requests);
    await expect(controller.create(validBody, makeReq('usr_actor'))).rejects.toMatchObject({
      status: 500,
    });
  });

  it('maps invalid_request to a 400', async () => {
    const failure: BookingsServiceFailure = {
      reason: 'invalid_request',
      message: 'actorUserId is required',
    };
    const requests = {
      createRequest: vi.fn().mockResolvedValueOnce(err(failure)),
    } as unknown as ConciergeRequestsService;
    const controller = new ConciergeRequestsController(requests);
    await expect(controller.create(validBody, makeReq('usr_actor'))).rejects.toMatchObject({
      status: 400,
    });
  });
});
