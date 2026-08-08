import { describe, expect, it } from 'vitest';

import {
  DASHBOARD_HISTORY_LIMIT_DEFAULT,
  DASHBOARD_HISTORY_LIMIT_MAX,
  DASHBOARD_WINDOW_DAYS_DEFAULT,
  DashboardVisitNoteSummarySchema,
  FamilyVisitsDashboardQuerySchema,
  FamilyVisitsDashboardResponseSchema,
} from '../http/booking-dashboard.schema';

/**
 * Contract tests for the TS-230 family peace-of-mind dashboard DTOs.
 */
describe('FamilyVisitsDashboardQuerySchema', () => {
  it('applies defaults for an empty query', () => {
    const parsed = FamilyVisitsDashboardQuerySchema.parse({});
    expect(parsed.windowDays).toBe(DASHBOARD_WINDOW_DAYS_DEFAULT);
    expect(parsed.historyLimit).toBe(DASHBOARD_HISTORY_LIMIT_DEFAULT);
    expect(parsed.seniorId).toBeUndefined();
    expect(parsed.historyCursor).toBeUndefined();
  });

  it.each([7, 30, 90])('accepts windowDays=%s (coerced from string)', (value) => {
    const parsed = FamilyVisitsDashboardQuerySchema.parse({ windowDays: String(value) });
    expect(parsed.windowDays).toBe(value);
  });

  it.each([1, 14, 60, 365, 0, -7])('rejects an unsupported windowDays=%s', (value) => {
    expect(FamilyVisitsDashboardQuerySchema.safeParse({ windowDays: String(value) }).success).toBe(
      false,
    );
  });

  it('coerces and bounds historyLimit', () => {
    expect(FamilyVisitsDashboardQuerySchema.parse({ historyLimit: '25' }).historyLimit).toBe(25);
    expect(
      FamilyVisitsDashboardQuerySchema.safeParse({
        historyLimit: String(DASHBOARD_HISTORY_LIMIT_MAX + 1),
      }).success,
    ).toBe(false);
    expect(FamilyVisitsDashboardQuerySchema.safeParse({ historyLimit: '0' }).success).toBe(false);
  });

  it('accepts an optional seniorId and historyCursor', () => {
    const parsed = FamilyVisitsDashboardQuerySchema.parse({
      seniorId: 'snr_123',
      historyCursor: 'opaque-cursor',
    });
    expect(parsed.seniorId).toBe('snr_123');
    expect(parsed.historyCursor).toBe('opaque-cursor');
  });

  it('rejects unknown fields (.strict)', () => {
    expect(FamilyVisitsDashboardQuerySchema.safeParse({ householdId: 'hh_1' }).success).toBe(false);
  });
});

describe('DashboardVisitNoteSummarySchema', () => {
  const valid = {
    mood: 'bright' as const,
    appetite: 'hearty' as const,
    hydration: 'good' as const,
    socialEngagement: 'engaged' as const,
    freeform: 'Enjoyed the soup and chatted about the garden.',
    photoCount: 2,
    recordedAt: '2026-05-20T16:30:00.000Z',
  };

  it('accepts a fully-populated summary', () => {
    expect(DashboardVisitNoteSummarySchema.safeParse(valid).success).toBe(true);
  });

  it('accepts all-null scales with zero photos', () => {
    expect(
      DashboardVisitNoteSummarySchema.safeParse({
        mood: null,
        appetite: null,
        hydration: null,
        socialEngagement: null,
        freeform: null,
        photoCount: 0,
        recordedAt: '2026-05-20T16:30:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects a negative photoCount', () => {
    expect(DashboardVisitNoteSummarySchema.safeParse({ ...valid, photoCount: -1 }).success).toBe(
      false,
    );
  });

  it('does not carry raw photoKeys or recordedByUserId (.strict)', () => {
    expect(DashboardVisitNoteSummarySchema.safeParse({ ...valid, photoKeys: ['a'] }).success).toBe(
      false,
    );
    expect(
      DashboardVisitNoteSummarySchema.safeParse({ ...valid, recordedByUserId: 'u_1' }).success,
    ).toBe(false);
  });
});

describe('FamilyVisitsDashboardResponseSchema', () => {
  const booking = {
    id: 'bkg_1',
    householdId: 'hh_1',
    seniorId: 'snr_1',
    providerId: 'prv_1',
    serviceKind: 'companion_dining' as const,
    status: 'completed' as const,
    scheduledStart: '2026-05-18T17:00:00.000Z',
    scheduledEnd: '2026-05-18T19:00:00.000Z',
    currency: 'USD',
    basePriceMinor: 12000,
    commissionRateBps: 2000,
    commissionAmountMinor: 2400,
    finalPriceMinor: 12000,
    bookingNotes: null,
    completedAt: '2026-05-18T19:05:00.000Z',
    canceledAt: null,
    cancellationReason: null,
    cancellationReasonText: null,
    acceptWindowExpiresAt: null,
    declinedAt: null,
    declineKind: null,
    declineReason: null,
    declineReasonText: null,
    declinedByUserId: null,
    onHold: false,
    createdAt: '2026-05-10T12:00:00.000Z',
    updatedAt: '2026-05-18T19:05:00.000Z',
  };

  it('accepts a populated dashboard with combined scope', () => {
    const parsed = FamilyVisitsDashboardResponseSchema.safeParse({
      householdId: 'hh_1',
      seniorId: null,
      windowDays: 30,
      upcoming: [{ ...booking, status: 'confirmed' }],
      history: [{ booking, visitNotes: null }],
      historyNextCursor: 'next-cursor',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a per-senior scope with a null cursor (last page)', () => {
    const parsed = FamilyVisitsDashboardResponseSchema.safeParse({
      householdId: 'hh_1',
      seniorId: 'snr_1',
      windowDays: 7,
      upcoming: [],
      history: [],
      historyNextCursor: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an out-of-set windowDays in the response', () => {
    expect(
      FamilyVisitsDashboardResponseSchema.safeParse({
        householdId: 'hh_1',
        seniorId: null,
        windowDays: 45,
        upcoming: [],
        history: [],
        historyNextCursor: null,
      }).success,
    ).toBe(false);
  });
});
