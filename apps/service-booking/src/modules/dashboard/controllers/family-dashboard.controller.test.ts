import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { BookingServiceKind } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import type { BookingRecord } from '../../bookings/services/bookings.service';
import {
  FamilyDashboardService,
  type FamilyDashboardResult,
} from '../services/family-dashboard.service';
import { FamilyDashboardController } from './family-dashboard.controller';

function makeRow(overrides: Partial<BookingRecord> = {}): BookingRecord {
  return {
    id: 'bkg_1',
    householdId: 'hh_1',
    seniorId: 'snr_1',
    providerId: 'prv_1',
    serviceKind: 'companion_dining' as BookingServiceKind,
    status: 'confirmed',
    scheduledStart: new Date('2026-05-30T17:00:00.000Z'),
    scheduledEnd: new Date('2026-05-30T19:00:00.000Z'),
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
    acceptWindowExpiresAt: null,
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    heldByIncidentId: null,
    createdAt: new Date('2026-05-10T12:00:00.000Z'),
    updatedAt: new Date('2026-05-10T12:00:00.000Z'),
    ...overrides,
  };
}

function buildController(result?: Partial<FamilyDashboardResult>): {
  controller: FamilyDashboardController;
  loadDashboard: ReturnType<typeof vi.fn>;
} {
  const fullResult: FamilyDashboardResult = {
    householdId: 'hh_1',
    seniorId: null,
    windowDays: 30,
    upcoming: [makeRow()],
    history: [],
    historyNextCursor: null,
    ...result,
  };
  const loadDashboard = vi.fn(async () => fullResult);
  const service = { loadDashboard } as unknown as FamilyDashboardService;
  return { controller: new FamilyDashboardController(service), loadDashboard };
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

describe('FamilyDashboardController.getMyDashboard', () => {
  it('resolves the household from the token and forwards the query args', async () => {
    const { controller, loadDashboard } = buildController();
    const response = await controller.getMyDashboard(
      { windowDays: 90, seniorId: 'snr_7', historyCursor: 'cur', historyLimit: 25 },
      householdRequest('hh_99'),
    );
    expect(loadDashboard).toHaveBeenCalledWith({
      householdId: 'hh_99',
      seniorId: 'snr_7',
      windowDays: 90,
      historyCursor: 'cur',
      historyLimit: 25,
    });
    expect(response.householdId).toBe('hh_1');
    expect(response.upcoming).toHaveLength(1);
    expect(response.upcoming[0]?.id).toBe('bkg_1');
  });

  it('passes seniorId=undefined for the combined view', async () => {
    const { controller, loadDashboard } = buildController();
    await controller.getMyDashboard({ windowDays: 30, historyLimit: 10 }, householdRequest());
    expect(loadDashboard).toHaveBeenCalledWith({
      householdId: 'hh_1',
      seniorId: undefined,
      windowDays: 30,
      historyCursor: undefined,
      historyLimit: 10,
    });
  });

  it('maps booking rows to integer-minor BookingResponse shape', async () => {
    const { controller } = buildController({ upcoming: [makeRow({ id: 'bkg_x' })] });
    const response = await controller.getMyDashboard(
      { windowDays: 30, historyLimit: 10 },
      householdRequest(),
    );
    expect(response.upcoming[0]?.basePriceMinor).toBe(15000);
    expect(response.upcoming[0]?.commissionRateBps).toBe(2000);
  });

  it('rejects a non-household-scoped actor with a 400', async () => {
    const { controller, loadDashboard } = buildController();
    await expect(
      controller.getMyDashboard({ windowDays: 30, historyLimit: 10 }, globalRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(loadDashboard).not.toHaveBeenCalled();
  });

  it('rejects a request with no auth context with a 401', async () => {
    const { controller } = buildController();
    await expect(
      controller.getMyDashboard(
        { windowDays: 30, historyLimit: 10 },
        {} as unknown as RequestWithContext,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
