import { randomBytes, randomUUID } from 'node:crypto';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SeniorIntake } from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import { IntakePayloadCipherService } from './intake-payload-cipher.service';
import { IntakeService } from './intake.service';

interface FakeSeniorRow {
  id: string;
  householdId: string;
  deletedAt: Date | null;
  languageTags: string[];
  dietaryTags: string[];
  allergenTags: string[];
  mobilityLevel: string;
  dementiaStatus: string;
  intakePayloadCiphertext: Buffer | null;
  intakePayloadIv: Buffer | null;
  intakePayloadAuthTag: Buffer | null;
  intakePayloadKeyVersion: number | null;
  intakeCompletedAt: Date | null;
  updatedAt: Date;
}

interface FakeMembership {
  id: string;
  householdId: string;
  userId: string;
  memberRole: string;
  removedAt: Date | null;
}

interface FakeConsent {
  seniorId: string;
  health: boolean;
}

/**
 * Minimal Prisma stand-in. The IntakeService uses two model methods:
 *   - prisma.senior.findFirst({ where, select })
 *   - prisma.senior.update({ where: { id }, data, select })
 *   - prisma.householdMember.findFirst({ where: {...}, select })
 *
 * We don't need a full Prisma fake — just enough of the surface to
 * exercise the auth + persistence paths. The select clauses on the
 * real service are also exercised because Prisma's runtime ignores
 * extra `select` keys, so a permissive fake matches production behaviour.
 */
class FakePrisma {
  public seniors: FakeSeniorRow[] = [];
  public memberships: FakeMembership[] = [];
  public consents: FakeConsent[] = [];

  senior = {
    findFirst: async (args: {
      where: { id: string; deletedAt: null };
    }): Promise<FakeSeniorRow | null> => {
      const found = this.seniors.find((s) => s.id === args.where.id && s.deletedAt === null);
      return found ?? null;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeSeniorRow>;
    }): Promise<FakeSeniorRow> => {
      const row = this.seniors.find((s) => s.id === args.where.id);
      if (row === undefined) throw new Error('senior row missing in fake');
      // Mirror real Prisma semantics: `undefined` means "don't update
      // this column", `null` means "explicitly set to null". Filtering
      // out undefined keys before Object.assign is the difference
      // between the two.
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

  seniorConsent = {
    findUnique: async (args: { where: { seniorId: string } }): Promise<FakeConsent | null> => {
      return this.consents.find((c) => c.seniorId === args.where.seniorId) ?? null;
    },
  };
}

function newSenior(overrides: Partial<FakeSeniorRow> = {}): FakeSeniorRow {
  return {
    id: `snr_${randomUUID()}`,
    householdId: `hh_${randomUUID()}`,
    deletedAt: null,
    languageTags: [],
    dietaryTags: [],
    allergenTags: [],
    mobilityLevel: 'unknown',
    dementiaStatus: 'none',
    intakePayloadCiphertext: null,
    intakePayloadIv: null,
    intakePayloadAuthTag: null,
    intakePayloadKeyVersion: null,
    intakeCompletedAt: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCipher(): IntakePayloadCipherService {
  const env = {
    HOUSEHOLD_INTAKE_ENC_KEY: randomBytes(32).toString('base64'),
    HOUSEHOLD_INTAKE_ENC_KEY_VERSION: 1,
  } as unknown as Env;
  return new IntakePayloadCipherService(env);
}

function intakeFor(overrides: Partial<SeniorIntake> = {}): SeniorIntake {
  return {
    dementiaStatus: 'none',
    mobilityLevel: 'unknown',
    languageTags: [],
    dietaryTags: [],
    allergenTags: [],
    ...overrides,
  } as SeniorIntake;
}

describe('IntakeService.upsert', () => {
  let prisma: FakePrisma;
  let cipher: IntakePayloadCipherService;
  let service: IntakeService;
  let senior: FakeSeniorRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    cipher = makeCipher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: the FakePrisma intentionally implements only the narrow Prisma surface IntakeService uses; coercing it to PrismaService here is the standard test pattern in this codebase.
    service = new IntakeService(prisma as any, cipher);
    senior = newSenior();
    prisma.seniors.push(senior);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: senior.householdId,
      userId: memberUserId,
      memberRole: 'primary_payer',
      removedAt: null,
    });
  });

  it('encrypts sensitive fields and persists operational tags in cleartext', async () => {
    const result = await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor({
        dateOfBirth: '1942-03-14',
        dietaryTags: ['kosher', 'low_sodium'],
        allergenTags: ['peanut'],
        medicalNotes: 'Type 2 diabetes, well controlled.',
        dementiaStatus: 'early_dementia',
        mobilityLevel: 'aided_walker',
      }),
    });

    // Persisted operational columns are stored cleartext.
    expect(senior.dietaryTags).toEqual(['kosher', 'low_sodium']);
    expect(senior.allergenTags).toEqual(['peanut']);
    expect(senior.mobilityLevel).toBe('aided_walker');
    expect(senior.dementiaStatus).toBe('early_dementia');

    // Persisted sensitive payload is encrypted, NOT cleartext.
    expect(senior.intakePayloadCiphertext).toBeInstanceOf(Buffer);
    expect(senior.intakePayloadIv?.length).toBe(12);
    expect(senior.intakePayloadAuthTag?.length).toBe(16);
    expect(senior.intakePayloadKeyVersion).toBe(1);
    // Defence-in-depth: the cleartext DOB must NOT appear anywhere in the
    // persisted ciphertext (rules out a no-op cipher implementation).
    expect(senior.intakePayloadCiphertext?.toString('utf8').includes('1942-03-14')).toBe(false);

    // Round-trip — the response surfaces the decrypted DOB.
    expect(result.dateOfBirth).toBe('1942-03-14');
    expect(result.medicalNotes).toBe('Type 2 diabetes, well controlled.');
    expect(result.intakeCompletedAt).not.toBeNull();
  });

  it('stamps intakeCompletedAt only on the first non-empty write', async () => {
    // First write: completes the intake.
    await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor({ dietaryTags: ['kosher'] }),
    });
    const firstStamp = senior.intakeCompletedAt;
    expect(firstStamp).not.toBeNull();

    // Second write: must NOT advance the stamp.
    await new Promise((r) => setTimeout(r, 5));
    await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor({ dietaryTags: ['kosher', 'low_sodium'] }),
    });
    expect(senior.intakeCompletedAt).toBe(firstStamp);
  });

  it('does NOT stamp intakeCompletedAt on an entirely-empty intake', async () => {
    await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor(),
    });
    expect(senior.intakeCompletedAt).toBeNull();
    expect(senior.intakePayloadCiphertext).toBeNull();
  });

  it('writes NULL to the encrypted columns when only operational fields are filled', async () => {
    await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor({ dietaryTags: ['vegetarian'] }),
    });
    expect(senior.intakePayloadCiphertext).toBeNull();
    expect(senior.intakePayloadIv).toBeNull();
    expect(senior.intakePayloadAuthTag).toBeNull();
    expect(senior.intakePayloadKeyVersion).toBeNull();
    // BUT intakeCompletedAt is set — having any operational signal is
    // enough to flip the dashboard nudge off.
    expect(senior.intakeCompletedAt).not.toBeNull();
  });

  it('clears the encrypted columns when a subsequent write removes all sensitive fields', async () => {
    await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor({ dateOfBirth: '1942-03-14' }),
    });
    expect(senior.intakePayloadCiphertext).not.toBeNull();

    await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor({ dietaryTags: ['vegetarian'] }),
    });
    expect(senior.intakePayloadCiphertext).toBeNull();
    expect(senior.intakePayloadIv).toBeNull();
  });

  it('returns 404 NotFound when the senior does not exist', async () => {
    await expect(
      service.upsert({
        seniorId: 'snr_missing',
        requesterUserId: memberUserId,
        intake: intakeFor(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 NotFound when the senior is soft-deleted', async () => {
    senior.deletedAt = new Date();
    await expect(
      service.upsert({
        seniorId: senior.id,
        requesterUserId: memberUserId,
        intake: intakeFor(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 Forbidden when the requester is not a member of the household', async () => {
    const stranger = `usr_${randomUUID()}`;
    await expect(
      service.upsert({
        seniorId: senior.id,
        requesterUserId: stranger,
        intake: intakeFor(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 403 Forbidden when the membership has been removed', async () => {
    if (prisma.memberships[0]) prisma.memberships[0].removedAt = new Date();
    await expect(
      service.upsert({
        seniorId: senior.id,
        requesterUserId: memberUserId,
        intake: intakeFor(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('IntakeService.get', () => {
  let prisma: FakePrisma;
  let cipher: IntakePayloadCipherService;
  let service: IntakeService;
  let senior: FakeSeniorRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    cipher = makeCipher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: see upsert describe block.
    service = new IntakeService(prisma as any, cipher);
    senior = newSenior();
    prisma.seniors.push(senior);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: senior.householdId,
      userId: memberUserId,
      memberRole: 'primary_payer',
      removedAt: null,
    });
  });

  it('returns the empty-shape response when the intake has never been completed', async () => {
    const result = await service.get({
      seniorId: senior.id,
      requesterUserId: memberUserId,
    });
    expect(result.dateOfBirth).toBeNull();
    expect(result.medicalNotes).toBeNull();
    expect(result.dietaryTags).toEqual([]);
    expect(result.dementiaStatus).toBe('none');
    expect(result.mobilityLevel).toBe('unknown');
    expect(result.intakeCompletedAt).toBeNull();
  });

  it('decrypts a previously-persisted payload', async () => {
    await service.upsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      intake: intakeFor({
        dateOfBirth: '1942-03-14',
        allergyNotes: 'Anaphylaxis on peanut.',
      }),
    });
    const result = await service.get({
      seniorId: senior.id,
      requesterUserId: memberUserId,
    });
    expect(result.dateOfBirth).toBe('1942-03-14');
    expect(result.allergyNotes).toBe('Anaphylaxis on peanut.');
  });

  it('enforces the same auth check as upsert', async () => {
    const stranger = `usr_${randomUUID()}`;
    await expect(
      service.get({ seniorId: senior.id, requesterUserId: stranger }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('IntakeService.get — TS-238 family-observability health-consent gate', () => {
  let prisma: FakePrisma;
  let service: IntakeService;
  let senior: FakeSeniorRow;
  let payerUserId: string;
  let observerUserId: string;
  let seniorUserId: string;

  beforeEach(async () => {
    prisma = new FakePrisma();
    const cipher = makeCipher();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: see upsert describe block.
    service = new IntakeService(prisma as any, cipher);
    senior = newSenior();
    prisma.seniors.push(senior);

    payerUserId = `usr_${randomUUID()}`;
    observerUserId = `usr_${randomUUID()}`;
    seniorUserId = `usr_${randomUUID()}`;
    prisma.memberships.push(
      {
        id: `mem_${randomUUID()}`,
        householdId: senior.householdId,
        userId: payerUserId,
        memberRole: 'primary_payer',
        removedAt: null,
      },
      {
        id: `mem_${randomUUID()}`,
        householdId: senior.householdId,
        userId: observerUserId,
        memberRole: 'family_observer',
        removedAt: null,
      },
      {
        id: `mem_${randomUUID()}`,
        householdId: senior.householdId,
        userId: seniorUserId,
        memberRole: 'senior_user',
        removedAt: null,
      },
    );

    // The senior has a completed intake so a successful read returns real
    // data (rules out the empty-shape masking the gate).
    await service.upsert({
      seniorId: senior.id,
      requesterUserId: payerUserId,
      intake: intakeFor({ dateOfBirth: '1942-03-14', medicalNotes: 'Type 2 diabetes.' }),
    });
  });

  it('blocks a family observer with 403 when no consent row exists (opt-out default)', async () => {
    await expect(
      service.get({ seniorId: senior.id, requesterUserId: observerUserId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks a family observer with 403 when health consent is explicitly false', async () => {
    prisma.consents.push({ seniorId: senior.id, health: false });
    await expect(
      service.get({ seniorId: senior.id, requesterUserId: observerUserId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows a family observer to read when health consent is granted', async () => {
    prisma.consents.push({ seniorId: senior.id, health: true });
    const result = await service.get({ seniorId: senior.id, requesterUserId: observerUserId });
    expect(result.dateOfBirth).toBe('1942-03-14');
    expect(result.medicalNotes).toBe('Type 2 diabetes.');
  });

  it('always lets the primary payer read regardless of consent (account manager, not observer)', async () => {
    const result = await service.get({ seniorId: senior.id, requesterUserId: payerUserId });
    expect(result.dateOfBirth).toBe('1942-03-14');
  });

  it('always lets the senior end-user read their own intake regardless of consent', async () => {
    const result = await service.get({ seniorId: senior.id, requesterUserId: seniorUserId });
    expect(result.dateOfBirth).toBe('1942-03-14');
  });
});
