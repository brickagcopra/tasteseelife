import { randomBytes, randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { HouseholdAccessInstructions } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { AccessInstructionsCipherService } from './access-instructions-cipher.service';
import { HouseholdAccessService } from './household-access.service';

interface FakeHouseholdRow {
  id: string;
  deletedAt: Date | null;
  accessInstructionsCiphertext: Buffer | null;
  accessInstructionsIv: Buffer | null;
  accessInstructionsAuthTag: Buffer | null;
  accessInstructionsKeyVersion: number | null;
  accessInstructionsUpdatedAt: Date | null;
  updatedAt: Date;
}

interface FakeMembership {
  id: string;
  householdId: string;
  userId: string;
  removedAt: Date | null;
}

/**
 * Minimal Prisma fake — only the three methods HouseholdAccessService
 * touches. Tracks rows and memberships in plain arrays; permissive
 * select clauses (real Prisma ignores extra select keys, our fake does
 * the same).
 */
class FakePrisma {
  public households: FakeHouseholdRow[] = [];
  public memberships: FakeMembership[] = [];

  household = {
    findFirst: async (args: {
      where: { id: string; deletedAt: null };
    }): Promise<FakeHouseholdRow | null> => {
      const found = this.households.find((h) => h.id === args.where.id && h.deletedAt === null);
      return found ?? null;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeHouseholdRow>;
    }): Promise<FakeHouseholdRow> => {
      const row = this.households.find((h) => h.id === args.where.id);
      if (row === undefined) throw new Error('household row missing in fake');
      const writable = row as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        writable[key] = value;
      }
      row.updatedAt = new Date();
      return row;
    },
  };

  householdMember = {
    findFirst: async (args: {
      where: { householdId: string; userId: string; removedAt: null };
    }): Promise<FakeMembership | null> => {
      const found = this.memberships.find(
        (m) =>
          m.householdId === args.where.householdId &&
          m.userId === args.where.userId &&
          m.removedAt === null,
      );
      return found ?? null;
    },
  };
}

function newHousehold(overrides: Partial<FakeHouseholdRow> = {}): FakeHouseholdRow {
  return {
    id: `hh_${randomUUID()}`,
    deletedAt: null,
    accessInstructionsCiphertext: null,
    accessInstructionsIv: null,
    accessInstructionsAuthTag: null,
    accessInstructionsKeyVersion: null,
    accessInstructionsUpdatedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCipher(): AccessInstructionsCipherService {
  const env = {
    HOUSEHOLD_ACCESS_ENC_KEY: randomBytes(32).toString('base64'),
    HOUSEHOLD_ACCESS_ENC_KEY_VERSION: 1,
  } as unknown as Env;
  return new AccessInstructionsCipherService(env);
}

function payload(
  overrides: Partial<HouseholdAccessInstructions> = {},
): HouseholdAccessInstructions {
  return { ...overrides };
}

describe('HouseholdAccessService.upsert', () => {
  let prisma: FakePrisma;
  let cipher: AccessInstructionsCipherService;
  let service: HouseholdAccessService;
  let household: FakeHouseholdRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    cipher = makeCipher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: the FakePrisma intentionally implements only the narrow Prisma surface HouseholdAccessService uses; coercing it to PrismaService here matches the IntakeService test pattern.
    service = new HouseholdAccessService(prisma as any, cipher);
    household = newHousehold();
    prisma.households.push(household);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: household.id,
      userId: memberUserId,
      removedAt: null,
    });
  });

  it('encrypts a non-empty payload and stamps accessInstructionsUpdatedAt', async () => {
    const result = await service.upsert({
      householdId: household.id,
      requesterUserId: memberUserId,
      payload: payload({
        doorCode: '4242',
        keyLocation: 'Lockbox to left of door.',
        alarmCode: '8888',
      }),
    });

    expect(household.accessInstructionsCiphertext).toBeInstanceOf(Buffer);
    expect(household.accessInstructionsIv?.length).toBe(12);
    expect(household.accessInstructionsAuthTag?.length).toBe(16);
    expect(household.accessInstructionsKeyVersion).toBe(1);
    expect(household.accessInstructionsUpdatedAt).not.toBeNull();

    // Defence-in-depth: the door code MUST NOT appear in cleartext on the
    // persisted ciphertext (rules out a no-op cipher).
    expect(household.accessInstructionsCiphertext?.toString('utf8').includes('4242')).toBe(false);

    expect(result.doorCode).toBe('4242');
    expect(result.alarmCode).toBe('8888');
    expect(result.accessInstructionsUpdatedAt).not.toBeNull();
  });

  it('clears the encrypted columns AND timestamp on an entirely-empty payload', async () => {
    // First write some real data, then clear it.
    await service.upsert({
      householdId: household.id,
      requesterUserId: memberUserId,
      payload: payload({ doorCode: '4242' }),
    });
    expect(household.accessInstructionsCiphertext).not.toBeNull();
    expect(household.accessInstructionsUpdatedAt).not.toBeNull();

    await service.upsert({
      householdId: household.id,
      requesterUserId: memberUserId,
      payload: payload(),
    });
    expect(household.accessInstructionsCiphertext).toBeNull();
    expect(household.accessInstructionsIv).toBeNull();
    expect(household.accessInstructionsAuthTag).toBeNull();
    expect(household.accessInstructionsKeyVersion).toBeNull();
    expect(household.accessInstructionsUpdatedAt).toBeNull();
  });

  it('treats explicit null as empty (same as undefined)', async () => {
    await service.upsert({
      householdId: household.id,
      requesterUserId: memberUserId,
      payload: payload({
        doorCode: null,
        keyLocation: null,
        alarmCode: null,
        alarmDisarmInstructions: null,
        parkingInstructions: null,
        doormanInfo: null,
        petInfo: null,
        generalNotes: null,
      }),
    });
    expect(household.accessInstructionsCiphertext).toBeNull();
    expect(household.accessInstructionsUpdatedAt).toBeNull();
  });

  it('persists a single non-null field as a non-empty payload', async () => {
    await service.upsert({
      householdId: household.id,
      requesterUserId: memberUserId,
      payload: payload({ petInfo: 'Indoor cat Whiskers — never let outside.' }),
    });
    expect(household.accessInstructionsCiphertext).not.toBeNull();
    expect(household.accessInstructionsUpdatedAt).not.toBeNull();
  });

  it('returns 404 NotFound when the household does not exist', async () => {
    await expect(
      service.upsert({
        householdId: 'hh_missing',
        requesterUserId: memberUserId,
        payload: payload(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 NotFound when the household is soft-deleted', async () => {
    household.deletedAt = new Date();
    await expect(
      service.upsert({
        householdId: household.id,
        requesterUserId: memberUserId,
        payload: payload(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 Forbidden when the requester is not a household member', async () => {
    const stranger = `usr_${randomUUID()}`;
    await expect(
      service.upsert({
        householdId: household.id,
        requesterUserId: stranger,
        payload: payload(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 Forbidden when the membership has been removed', async () => {
    if (prisma.memberships[0]) prisma.memberships[0].removedAt = new Date();
    await expect(
      service.upsert({
        householdId: household.id,
        requesterUserId: memberUserId,
        payload: payload(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('HouseholdAccessService.get', () => {
  let prisma: FakePrisma;
  let cipher: AccessInstructionsCipherService;
  let service: HouseholdAccessService;
  let household: FakeHouseholdRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    cipher = makeCipher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: see upsert describe block.
    service = new HouseholdAccessService(prisma as any, cipher);
    household = newHousehold();
    prisma.households.push(household);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: household.id,
      userId: memberUserId,
      removedAt: null,
    });
  });

  it('returns the empty-shape response when nothing has been persisted', async () => {
    const result = await service.get({
      householdId: household.id,
      requesterUserId: memberUserId,
    });
    expect(result.doorCode).toBeNull();
    expect(result.alarmCode).toBeNull();
    expect(result.generalNotes).toBeNull();
    expect(result.accessInstructionsUpdatedAt).toBeNull();
  });

  it('decrypts a previously-persisted payload', async () => {
    await service.upsert({
      householdId: household.id,
      requesterUserId: memberUserId,
      payload: payload({
        doorCode: '4242',
        doormanInfo: 'Mike 7am–3pm.',
      }),
    });
    const result = await service.get({
      householdId: household.id,
      requesterUserId: memberUserId,
    });
    expect(result.doorCode).toBe('4242');
    expect(result.doormanInfo).toBe('Mike 7am–3pm.');
  });

  it('enforces the same auth check as upsert', async () => {
    const stranger = `usr_${randomUUID()}`;
    await expect(
      service.get({ householdId: household.id, requesterUserId: stranger }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 404 NotFound when the household does not exist', async () => {
    await expect(
      service.get({ householdId: 'hh_missing', requesterUserId: memberUserId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
