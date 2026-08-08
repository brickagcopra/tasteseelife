import { randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SENIOR_ALERT_PREFERENCES_DEFAULTS } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { SeniorAlertPreferencesService } from './senior-alert-preferences.service';

interface FakeSenior {
  id: string;
  householdId: string;
  deletedAt: Date | null;
}

interface FakeMembership {
  householdId: string;
  userId: string;
  removedAt: Date | null;
}

interface FakePreferenceRow {
  seniorId: string;
  userId: string;
  missedVisit: boolean;
  concerningObservation: boolean;
  emergencyFlag: boolean;
  updatedAt: Date;
}

/**
 * Minimal Prisma stand-in. SeniorAlertPreferencesService uses:
 *   - prisma.senior.findFirst({ where, select })
 *   - prisma.householdMember.findFirst({ where, select })
 *   - prisma.seniorAlertPreference.findUnique({ where: { seniorId_userId }, select })
 *   - prisma.seniorAlertPreference.upsert({ where: { seniorId_userId }, create, update, select })
 *
 * The composite-key `where` is the load-bearing detail: a member can only
 * ever touch their own `(seniorId, userId)` row.
 */
class FakePrisma {
  public seniors: FakeSenior[] = [];
  public memberships: FakeMembership[] = [];
  public preferences: FakePreferenceRow[] = [];

  senior = {
    findFirst: async (args: {
      where: { id: string; deletedAt: null };
    }): Promise<FakeSenior | null> => {
      return this.seniors.find((s) => s.id === args.where.id && s.deletedAt === null) ?? null;
    },
  };

  householdMember = {
    findFirst: async (args: {
      where: { householdId: string; userId: string; removedAt: null };
    }): Promise<{ id: string } | null> => {
      const match = this.memberships.find(
        (m) =>
          m.householdId === args.where.householdId &&
          m.userId === args.where.userId &&
          m.removedAt === null,
      );
      return match === undefined ? null : { id: 'member_id' };
    },
  };

  seniorAlertPreference = {
    findUnique: async (args: {
      where: { seniorId_userId: { seniorId: string; userId: string } };
    }): Promise<FakePreferenceRow | null> => {
      const { seniorId, userId } = args.where.seniorId_userId;
      return this.preferences.find((p) => p.seniorId === seniorId && p.userId === userId) ?? null;
    },
    upsert: async (args: {
      where: { seniorId_userId: { seniorId: string; userId: string } };
      create: Omit<FakePreferenceRow, 'updatedAt'>;
      update: Partial<FakePreferenceRow>;
    }): Promise<FakePreferenceRow> => {
      const { seniorId, userId } = args.where.seniorId_userId;
      const existing = this.preferences.find((p) => p.seniorId === seniorId && p.userId === userId);
      if (existing === undefined) {
        const row: FakePreferenceRow = { ...args.create, updatedAt: new Date() };
        this.preferences.push(row);
        return row;
      }
      Object.assign(existing, args.update);
      existing.updatedAt = new Date();
      return existing;
    },
  };
}

function makeService(prisma: FakePrisma): SeniorAlertPreferencesService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: the FakePrisma implements only the narrow Prisma surface the service uses.
  return new SeniorAlertPreferencesService(prisma as any);
}

describe('SeniorAlertPreferencesService.getMyPreferences', () => {
  let prisma: FakePrisma;
  let service: SeniorAlertPreferencesService;
  let senior: FakeSenior;
  let payerUserId: string;
  let observerUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = makeService(prisma);
    senior = { id: `snr_${randomUUID()}`, householdId: `hh_${randomUUID()}`, deletedAt: null };
    prisma.seniors.push(senior);
    payerUserId = `usr_${randomUUID()}`;
    observerUserId = `usr_${randomUUID()}`;
    prisma.memberships.push(
      { householdId: senior.householdId, userId: payerUserId, removedAt: null },
      { householdId: senior.householdId, userId: observerUserId, removedAt: null },
    );
  });

  it('returns the synthesised default when no row exists (operational on, observation off)', async () => {
    const result = await service.getMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
    });
    expect(result).toEqual({
      seniorId: senior.id,
      missedVisit: true,
      concerningObservation: false,
      emergencyFlag: true,
      updatedAt: null,
    });
  });

  it('the synthesised default matches SENIOR_ALERT_PREFERENCES_DEFAULTS', async () => {
    const result = await service.getMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
    });
    expect({
      missedVisit: result.missedVisit,
      concerningObservation: result.concerningObservation,
      emergencyFlag: result.emergencyFlag,
    }).toEqual(SENIOR_ALERT_PREFERENCES_DEFAULTS);
  });

  it('reflects a stored row with an updatedAt timestamp', async () => {
    await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { missedVisit: false, concerningObservation: true, emergencyFlag: true },
    });
    const result = await service.getMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
    });
    expect(result.missedVisit).toBe(false);
    expect(result.concerningObservation).toBe(true);
    expect(result.emergencyFlag).toBe(true);
    expect(result.updatedAt).not.toBeNull();
  });

  it('returns each member their OWN row, not another member’s', async () => {
    await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { missedVisit: false, concerningObservation: false, emergencyFlag: false },
    });
    // The observer never set theirs — they still see the default.
    const observerResult = await service.getMyPreferences({
      seniorId: senior.id,
      requesterUserId: observerUserId,
    });
    expect(observerResult.updatedAt).toBeNull();
    expect(observerResult.missedVisit).toBe(true);
    // The payer sees their own (all-off) row.
    const payerResult = await service.getMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
    });
    expect(payerResult.missedVisit).toBe(false);
    expect(prisma.preferences).toHaveLength(1);
  });

  it('any active household member may read (observer included)', async () => {
    const result = await service.getMyPreferences({
      seniorId: senior.id,
      requesterUserId: observerUserId,
    });
    expect(result.seniorId).toBe(senior.id);
  });

  it('returns 404 when the senior does not exist', async () => {
    await expect(
      service.getMyPreferences({ seniorId: 'snr_missing', requesterUserId: payerUserId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the senior is soft-deleted', async () => {
    senior.deletedAt = new Date();
    await expect(
      service.getMyPreferences({ seniorId: senior.id, requesterUserId: payerUserId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.getMyPreferences({ seniorId: senior.id, requesterUserId: `usr_${randomUUID()}` }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('SeniorAlertPreferencesService.setMyPreferences', () => {
  let prisma: FakePrisma;
  let service: SeniorAlertPreferencesService;
  let senior: FakeSenior;
  let payerUserId: string;
  let observerUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = makeService(prisma);
    senior = { id: `snr_${randomUUID()}`, householdId: `hh_${randomUUID()}`, deletedAt: null };
    prisma.seniors.push(senior);
    payerUserId = `usr_${randomUUID()}`;
    observerUserId = `usr_${randomUUID()}`;
    prisma.memberships.push(
      { householdId: senior.householdId, userId: payerUserId, removedAt: null },
      { householdId: senior.householdId, userId: observerUserId, removedAt: null },
    );
  });

  it('creates a row on first set, keyed to the caller', async () => {
    const result = await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { missedVisit: true, concerningObservation: true, emergencyFlag: false },
    });
    expect(result.missedVisit).toBe(true);
    expect(result.concerningObservation).toBe(true);
    expect(result.emergencyFlag).toBe(false);
    expect(result.updatedAt).not.toBeNull();
    expect(prisma.preferences).toHaveLength(1);
    expect(prisma.preferences[0]?.userId).toBe(payerUserId);
  });

  it('updates an existing row (full replace)', async () => {
    await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { missedVisit: true, concerningObservation: true, emergencyFlag: true },
    });
    const result = await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { missedVisit: false, concerningObservation: false, emergencyFlag: false },
    });
    expect(result.missedVisit).toBe(false);
    expect(result.concerningObservation).toBe(false);
    expect(result.emergencyFlag).toBe(false);
    expect(prisma.preferences).toHaveLength(1);
  });

  it('an observer may set their own subscription (no manager gate, unlike consent)', async () => {
    const result = await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: observerUserId,
      flags: { missedVisit: true, concerningObservation: false, emergencyFlag: true },
    });
    expect(result.missedVisit).toBe(true);
    expect(prisma.preferences[0]?.userId).toBe(observerUserId);
  });

  it('two members keep independent rows for the same senior', async () => {
    await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { missedVisit: true, concerningObservation: true, emergencyFlag: true },
    });
    await service.setMyPreferences({
      seniorId: senior.id,
      requesterUserId: observerUserId,
      flags: { missedVisit: false, concerningObservation: false, emergencyFlag: false },
    });
    expect(prisma.preferences).toHaveLength(2);
    const payerRow = prisma.preferences.find((p) => p.userId === payerUserId);
    const observerRow = prisma.preferences.find((p) => p.userId === observerUserId);
    expect(payerRow?.missedVisit).toBe(true);
    expect(observerRow?.missedVisit).toBe(false);
  });

  it('returns 404 when the senior does not exist', async () => {
    await expect(
      service.setMyPreferences({
        seniorId: 'snr_missing',
        requesterUserId: payerUserId,
        flags: { missedVisit: true, concerningObservation: false, emergencyFlag: true },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.preferences).toHaveLength(0);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.setMyPreferences({
        seniorId: senior.id,
        requesterUserId: `usr_${randomUUID()}`,
        flags: { missedVisit: true, concerningObservation: false, emergencyFlag: true },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.preferences).toHaveLength(0);
  });
});
