import { UnauthorizedException } from '@nestjs/common';
import type { SeniorConsentFlags, SeniorConsentResponse } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { SeniorConsentService } from '../services/senior-consent.service';
import { SeniorConsentController } from './senior-consent.controller';

function makeResponse(overrides: Partial<SeniorConsentResponse> = {}): SeniorConsentResponse {
  return {
    seniorId: 'snr_1',
    photos: false,
    notes: false,
    location: false,
    health: false,
    updatedAt: null,
    updatedByUserId: null,
    canManage: true,
    ...overrides,
  };
}

function makeController(service: Partial<SeniorConsentService>): SeniorConsentController {
  return new SeniorConsentController(service as SeniorConsentService);
}

function requestWith(userId: string | undefined): RequestWithContext {
  return {
    requestContext: userId === undefined ? undefined : { userId },
  } as unknown as RequestWithContext;
}

const FLAGS: SeniorConsentFlags = { photos: true, notes: false, location: false, health: true };

describe('SeniorConsentController idempotency wiring (TS-238)', () => {
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks PUT /api/v1/seniors/:seniorId/consent as @Idempotent()', () => {
    const handler = SeniorConsentController.prototype.set as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, handler)).toBe(true);
  });

  it('does NOT mark GET /api/v1/seniors/:seniorId/consent (read-only)', () => {
    const handler = SeniorConsentController.prototype.get as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, handler)).toBeUndefined();
  });
});

describe('SeniorConsentController delegation (TS-238)', () => {
  it('GET forwards the authenticated userId to the service', async () => {
    const getConsent = vi.fn().mockResolvedValue(makeResponse());
    const controller = makeController({ getConsent });
    await controller.get('snr_1', requestWith('usr_42'));
    expect(getConsent).toHaveBeenCalledWith({ seniorId: 'snr_1', requesterUserId: 'usr_42' });
  });

  it('PUT forwards the authenticated userId + flags to the service', async () => {
    const setConsent = vi.fn().mockResolvedValue(makeResponse({ photos: true, health: true }));
    const controller = makeController({ setConsent });
    const result = await controller.set('snr_1', FLAGS, requestWith('usr_42'), undefined);
    expect(setConsent).toHaveBeenCalledWith({
      seniorId: 'snr_1',
      requesterUserId: 'usr_42',
      flags: FLAGS,
    });
    expect(result.photos).toBe(true);
  });

  it('GET throws 401 when the request carries no auth context', async () => {
    const controller = makeController({ getConsent: vi.fn() });
    await expect(controller.get('snr_1', requestWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('PUT throws 401 when the request carries no auth context', async () => {
    const setConsent = vi.fn();
    const controller = makeController({ setConsent });
    await expect(
      controller.set('snr_1', FLAGS, requestWith(undefined), undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(setConsent).not.toHaveBeenCalled();
  });
});
