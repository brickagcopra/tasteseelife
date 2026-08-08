import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  WellnessAnomalyService,
  type WellnessAnomaliesResult,
} from '../services/wellness-anomaly.service';
import { WellnessAnomalyController } from './wellness-anomaly.controller';

function buildController(result?: Partial<WellnessAnomaliesResult>): {
  controller: WellnessAnomalyController;
  loadAnomalies: ReturnType<typeof vi.fn>;
} {
  const fullResult: WellnessAnomaliesResult = {
    seniorId: 'snr_1',
    windowDays: 30,
    totalCompletedVisits: 4,
    flags: [],
    generatedAt: new Date('2026-05-27T12:00:00.000Z'),
    ...result,
  };
  const loadAnomalies = vi.fn(async () => fullResult);
  const service = { loadAnomalies } as unknown as WellnessAnomalyService;
  return { controller: new WellnessAnomalyController(service), loadAnomalies };
}

function householdRequest(householdId = 'hh_1', userId = 'usr_family'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'household', householdId },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

function globalRequest(userId = 'usr_admin'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return { requestContext: ctx } as unknown as RequestWithContext;
}

describe('WellnessAnomalyController.getWellnessAnomalies', () => {
  it('resolves the household from the token and forwards the senior + window', async () => {
    const { controller, loadAnomalies } = buildController();
    const response = await controller.getWellnessAnomalies(
      'snr_7',
      { windowDays: 90 },
      householdRequest('hh_99'),
    );
    expect(loadAnomalies).toHaveBeenCalledWith({
      householdId: 'hh_99',
      seniorId: 'snr_7',
      windowDays: 90,
    });
    expect(response.seniorId).toBe('snr_1');
    expect(response.flags).toEqual([]);
    expect(response.generatedAt).toBe('2026-05-27T12:00:00.000Z');
  });

  it('serialises a flag through the published contract', async () => {
    const { controller } = buildController({
      totalCompletedVisits: 5,
      flags: [
        {
          metric: 'appetite',
          severity: 'high',
          baselineScore: 5,
          recentScore: 2,
          drop: 3,
          latestLevel: 'minimal',
          latestVisitDate: '2026-05-26T17:00:00.000Z',
          observationCount: 5,
        },
      ],
    });
    const response = await controller.getWellnessAnomalies(
      'snr_1',
      { windowDays: 30 },
      householdRequest(),
    );
    expect(response.flags).toHaveLength(1);
    expect(response.flags[0]?.metric).toBe('appetite');
    expect(response.flags[0]?.severity).toBe('high');
  });

  it('rejects a non-household-scoped actor with a 400', async () => {
    const { controller, loadAnomalies } = buildController();
    await expect(
      controller.getWellnessAnomalies('snr_1', { windowDays: 30 }, globalRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(loadAnomalies).not.toHaveBeenCalled();
  });

  it('rejects a request with no auth context with a 401', async () => {
    const { controller } = buildController();
    await expect(
      controller.getWellnessAnomalies(
        'snr_1',
        { windowDays: 30 },
        {} as unknown as RequestWithContext,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
