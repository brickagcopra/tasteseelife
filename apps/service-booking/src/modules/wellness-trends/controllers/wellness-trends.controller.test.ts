import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import { WELLNESS_TREND_METRICS } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import {
  WellnessTrendsService,
  type WellnessTrendsResult,
} from '../services/wellness-trends.service';
import { WellnessTrendsController } from './wellness-trends.controller';

function buildController(result?: Partial<WellnessTrendsResult>): {
  controller: WellnessTrendsController;
  loadTrends: ReturnType<typeof vi.fn>;
} {
  const fullResult: WellnessTrendsResult = {
    seniorId: 'snr_1',
    windowDays: 30,
    totalCompletedVisits: 2,
    series: WELLNESS_TREND_METRICS.map((metric) => ({
      metric,
      points: [],
      latestScore: null,
      visitsRecorded: 0,
    })),
    generatedAt: new Date('2026-05-27T12:00:00.000Z'),
    ...result,
  };
  const loadTrends = vi.fn(async () => fullResult);
  const service = { loadTrends } as unknown as WellnessTrendsService;
  return { controller: new WellnessTrendsController(service), loadTrends };
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

describe('WellnessTrendsController.getWellnessTrends', () => {
  it('resolves the household from the token and forwards the senior + window', async () => {
    const { controller, loadTrends } = buildController();
    const response = await controller.getWellnessTrends(
      'snr_7',
      { windowDays: 90 },
      householdRequest('hh_99'),
    );
    expect(loadTrends).toHaveBeenCalledWith({
      householdId: 'hh_99',
      seniorId: 'snr_7',
      windowDays: 90,
    });
    expect(response.seniorId).toBe('snr_1');
    expect(response.series).toHaveLength(WELLNESS_TREND_METRICS.length);
    expect(response.generatedAt).toBe('2026-05-27T12:00:00.000Z');
  });

  it('serialises generatedAt + point timestamps to ISO strings', async () => {
    const { controller } = buildController({
      series: [
        {
          metric: 'mood',
          points: [
            {
              bookingId: 'bkg_1',
              visitDate: '2026-05-20T17:00:00.000Z',
              recordedAt: '2026-05-20T18:00:00.000Z',
              level: 'bright',
              score: 4,
            },
          ],
          latestScore: 4,
          visitsRecorded: 1,
        },
      ],
    });
    const response = await controller.getWellnessTrends(
      'snr_1',
      { windowDays: 30 },
      householdRequest(),
    );
    expect(response.series[0]?.points[0]?.score).toBe(4);
    expect(typeof response.generatedAt).toBe('string');
  });

  it('rejects a non-household-scoped actor with a 400', async () => {
    const { controller, loadTrends } = buildController();
    await expect(
      controller.getWellnessTrends('snr_1', { windowDays: 30 }, globalRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(loadTrends).not.toHaveBeenCalled();
  });

  it('rejects a request with no auth context with a 401', async () => {
    const { controller } = buildController();
    await expect(
      controller.getWellnessTrends(
        'snr_1',
        { windowDays: 30 },
        {} as unknown as RequestWithContext,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
