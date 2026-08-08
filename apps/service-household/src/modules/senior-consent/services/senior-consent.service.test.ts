import { randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SeniorConsentFlags } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { SeniorConsentService } from './senior-consent.service';

interface FakeSenior {
  id: string;
  householdId: string;
  deletedAt: Date | null;
}

interface FakeMembership {
  householdId: string;
  userId: string;
  memberRole: string;
  removedAt: Date | null;
}

interface FakeConsentRow {
  seniorId: string;
  photos: boolean;
  notes: boolean;
  location: boolean;
  health: boolean;
  updatedByUserId: string | null;
  updatedAt: Date;
}

/**
 * Minimal Prisma stand-in. The SeniorConsentService uses:
 *   - prisma.senior.findFirst({ where, select })
 *   - prisma.householdMember.findFirst({ where, select })
 *   - prisma.seniorConsent.findUnique({ where, select })
 *   - prisma.seniorConsent.upsert({ where, create, update, select })
 *
 * The select clauses are exercised against production because Prisma's
 * runtime ignores extra `select` keys, so a permissive fake matches.
 */
class FakePrisma {
  public seniors: FakeSenior[] = [];
  public memberships: FakeMembership[] = [];
  public consents: FakeConsentRow[] = [];

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
    }): Promise<FakeMembership | null> => {
      return (
        this.memberships.find(
          (m) =>
            m.householdId === args.where.householdId &&
            m.userId === args.where.userId &&
            m.removedAt === null,
        ) ?? null
      );
    },
  };

  seniorConsent = {
    findUnique: async (args: { where: { seniorId: string } }): Promise<FakeConsentRow | null> => {
      return this.consents.find((c) => c.seniorId === args.where.seniorId) ?? null;
    },
    upsert: async (args: {
      where: { seniorId: string };
      create: FakeConsentRow;
      update: Partial<FakeConsentRow>;
    }): Promise<FakeConsentRow> => {
      const existing = this.consents.find((c) => c.seniorId === args.where.seniorId);
      if (existing === undefined) {
        const row: FakeConsentRow = { ...args.create, updatedAt: new Date() };
        this.consents.push(row);
        return row;
      }
      Object.assign(existing, args.update);
      existing.updatedAt = new Date();
      return existing;
    },
  };
}

function makeService(prisma: FakePrisma): SeniorConsentService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: the FakePrisma implements only the narrow Prisma surface the service uses.
  return new SeniorConsentService(prisma as any);
}

const ALL_FALSE: SeniorConsentFlags = {
  photos: false,
  notes: false,
  location: false,
  health: false,
};

describe('SeniorConsentService.getConsent', () => {
  let prisma: FakePrisma;
  let service: SeniorConsentService;
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
      {
        householdId: senior.householdId,
        userId: payerUserId,
        memberRole: 'primary_payer',
        removedAt: null,
      },
      {
        householdId: senior.householdId,
        userId: observerUserId,
        memberRole: 'family_observer',
        removedAt: null,
      },
    );
  });

  it('returns the all-false opt-out default when no consent row exists', async () => {
    const result = await service.getConsent({ seniorId: senior.id, requesterUserId: payerUserId });
    expect(result).toMatchObject({
      seniorId: senior.id,
      photos: false,
      notes: false,
      location: false,
      health: false,
      updatedAt: null,
      updatedByUserId: null,
    });
  });

  it('reflects a stored row with audit metadata', async () => {
    await service.setConsent({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { ...ALL_FALSE, health: true, photos: true },
    });
    const result = await service.getConsent({ seniorId: senior.id, requesterUserId: payerUserId });
    expect(result.health).toBe(true);
    expect(result.photos).toBe(true);
    expect(result.notes).toBe(false);
    expect(result.updatedAt).not.toBeNull();
    expect(result.updatedByUserId).toBe(payerUserId);
  });

  it('canManage is true for the primary payer', async () => {
    const result = await service.getConsent({ seniorId: senior.id, requesterUserId: payerUserId });
    expect(result.canManage).toBe(true);
  });

  it('canManage is false for a family observer (but they may still read)', async () => {
    const result = await service.getConsent({
      seniorId: senior.id,
      requesterUserId: observerUserId,
    });
    expect(result.canManage).toBe(false);
    expect(result.health).toBe(false);
  });

  it('returns 404 when the senior does not exist', async () => {
    await expect(
      service.getConsent({ seniorId: 'snr_missing', requesterUserId: payerUserId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the senior is soft-deleted', async () => {
    senior.deletedAt = new Date();
    await expect(
      service.getConsent({ seniorId: senior.id, requesterUserId: payerUserId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.getConsent({ seniorId: senior.id, requesterUserId: `usr_${randomUUID()}` }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('SeniorConsentService.setConsent', () => {
  let prisma: FakePrisma;
  let service: SeniorConsentService;
  let senior: FakeSenior;
  let payerUserId: string;
  let observerUserId: string;
  let seniorUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = makeService(prisma);
    senior = { id: `snr_${randomUUID()}`, householdId: `hh_${randomUUID()}`, deletedAt: null };
    prisma.seniors.push(senior);
    payerUserId = `usr_${randomUUID()}`;
    observerUserId = `usr_${randomUUID()}`;
    seniorUserId = `usr_${randomUUID()}`;
    prisma.memberships.push(
      {
        householdId: senior.householdId,
        userId: payerUserId,
        memberRole: 'primary_payer',
        removedAt: null,
      },
      {
        householdId: senior.householdId,
        userId: observerUserId,
        memberRole: 'family_observer',
        removedAt: null,
      },
      {
        householdId: senior.householdId,
        userId: seniorUserId,
        memberRole: 'senior_user',
        removedAt: null,
      },
    );
  });

  it('creates a consent row on first set, stamping the actor', async () => {
    const result = await service.setConsent({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { photos: true, notes: true, location: false, health: false },
    });
    expect(result.photos).toBe(true);
    expect(result.notes).toBe(true);
    expect(result.location).toBe(false);
    expect(result.updatedByUserId).toBe(payerUserId);
    expect(result.canManage).toBe(true);
    expect(prisma.consents).toHaveLength(1);
  });

  it('updates an existing row (full replace) and re-stamps the actor', async () => {
    await service.setConsent({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      flags: { ...ALL_FALSE, health: true },
    });
    const result = await service.setConsent({
      seniorId: senior.id,
      requesterUserId: seniorUserId,
      flags: { ...ALL_FALSE, notes: true },
    });
    expect(result.health).toBe(false); // full replace cleared the prior health flag
    expect(result.notes).toBe(true);
    expect(result.updatedByUserId).toBe(seniorUserId);
    expect(prisma.consents).toHaveLength(1);
  });

  it('lets the senior end-user set their own consent', async () => {
    const result = await service.setConsent({
      seniorId: senior.id,
      requesterUserId: seniorUserId,
      flags: { ...ALL_FALSE, photos: true },
    });
    expect(result.photos).toBe(true);
    expect(result.canManage).toBe(true);
  });

  it('returns 403 when a family observer tries to set consent', async () => {
    await expect(
      service.setConsent({
        seniorId: senior.id,
        requesterUserId: observerUserId,
        flags: { ...ALL_FALSE, photos: true },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.consents).toHaveLength(0);
  });

  it('returns 404 when the senior does not exist', async () => {
    await expect(
      service.setConsent({
        seniorId: 'snr_missing',
        requesterUserId: payerUserId,
        flags: ALL_FALSE,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.setConsent({
        seniorId: senior.id,
        requesterUserId: `usr_${randomUUID()}`,
        flags: ALL_FALSE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
