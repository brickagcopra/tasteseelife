import { UnauthorizedException } from '@nestjs/common';
import type {
  SeniorAlertPreferencesFlags,
  SeniorAlertPreferencesResponse,
} from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { SeniorAlertPreferencesService } from '../services/senior-alert-preferences.service';
import { SeniorAlertPreferencesController } from './senior-alert-preferences.controller';

function makeResponse(
  overrides: Partial<SeniorAlertPreferencesResponse> = {},
): SeniorAlertPreferencesResponse {
  return {
    seniorId: 'snr_1',
    missedVisit: true,
    concerningObservation: false,
    emergencyFlag: true,
    updatedAt: null,
    ...overrides,
  };
}

function makeController(
  service: Partial<SeniorAlertPreferencesService>,
): SeniorAlertPreferencesController {
  return new SeniorAlertPreferencesController(service as SeniorAlertPreferencesService);
}

function requestWith(userId: string | undefined): RequestWithContext {
  return {
    requestContext: userId === undefined ? undefined : { userId },
  } as unknown as RequestWithContext;
}

const FLAGS: SeniorAlertPreferencesFlags = {
  missedVisit: false,
  concerningObservation: true,
  emergencyFlag: true,
};

describe('SeniorAlertPreferencesController idempotency wiring (TS-234)', () => {
  const IDEMPOTENT_METADATA = Symbol.for('@taste-and-see/nest-idempotency:idempotent');

  it('marks PUT /api/v1/seniors/:seniorId/alert-preferences as @Idempotent()', () => {
    const handler = SeniorAlertPreferencesController.prototype.set as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, handler)).toBe(true);
  });

  it('does NOT mark GET /api/v1/seniors/:seniorId/alert-preferences (read-only)', () => {
    const handler = SeniorAlertPreferencesController.prototype.get as unknown as object;
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, handler)).toBeUndefined();
  });
});

describe('SeniorAlertPreferencesController delegation (TS-234)', () => {
  it('GET forwards the authenticated userId to the service', async () => {
    const getMyPreferences = vi.fn().mockResolvedValue(makeResponse());
    const controller = makeController({ getMyPreferences });
    await controller.get('snr_1', requestWith('usr_42'));
    expect(getMyPreferences).toHaveBeenCalledWith({ seniorId: 'snr_1', requesterUserId: 'usr_42' });
  });

  it('PUT forwards the authenticated userId + flags to the service', async () => {
    const setMyPreferences = vi
      .fn()
      .mockResolvedValue(makeResponse({ missedVisit: false, concerningObservation: true }));
    const controller = makeController({ setMyPreferences });
    const result = await controller.set('snr_1', FLAGS, requestWith('usr_42'), undefined);
    expect(setMyPreferences).toHaveBeenCalledWith({
      seniorId: 'snr_1',
      requesterUserId: 'usr_42',
      flags: FLAGS,
    });
    expect(result.concerningObservation).toBe(true);
  });

  it('PUT keys the row to the caller — it never reads a userId from the body', async () => {
    const setMyPreferences = vi.fn().mockResolvedValue(makeResponse());
    const controller = makeController({ setMyPreferences });
    await controller.set('snr_1', FLAGS, requestWith('usr_caller'), undefined);
    expect(setMyPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ requesterUserId: 'usr_caller' }),
    );
  });

  it('GET throws 401 when the request carries no auth context', async () => {
    const controller = makeController({ getMyPreferences: vi.fn() });
    await expect(controller.get('snr_1', requestWith(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('PUT throws 401 when the request carries no auth context', async () => {
    const setMyPreferences = vi.fn();
    const controller = makeController({ setMyPreferences });
    await expect(
      controller.set('snr_1', FLAGS, requestWith(undefined), undefined),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(setMyPreferences).not.toHaveBeenCalled();
  });
});
