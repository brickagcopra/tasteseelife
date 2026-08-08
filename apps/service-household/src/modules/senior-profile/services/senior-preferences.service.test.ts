import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SENIOR_PREFERENCES_MAX_PER_SENIOR,
  type BulkUpsertSeniorPreferencesRequest,
} from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { SeniorPreferencesService } from './senior-preferences.service';

interface FakePreferenceRow {
  seniorId: string;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeSeniorRow {
  id: string;
  householdId: string;
  deletedAt: Date | null;
}

interface FakeMembership {
  id: string;
  householdId: string;
  userId: string;
  removedAt: Date | null;
}

/**
 * Minimal Prisma fake — supports the surface SeniorPreferencesService
 * actually uses: senior.findFirst, householdMember.findFirst,
 * seniorPreference.findMany, .upsert, .deleteMany, and a
 * pass-through $transaction that runs the supplied promise array
 * sequentially against this fake (single-test-scope isolation; no
 * rollback semantics needed because the unit tests don't assert
 * partial-failure semantics — those land in the Testcontainers
 * integration test).
 */
class FakePrisma {
  public seniors: FakeSeniorRow[] = [];
  public memberships: FakeMembership[] = [];
  public preferences: FakePreferenceRow[] = [];
  private idCounter = 0;

  senior = {
    findFirst: async (args: {
      where: { id: string; deletedAt: null };
    }): Promise<FakeSeniorRow | null> => {
      const found = this.seniors.find((s) => s.id === args.where.id && s.deletedAt === null);
      return found ?? null;
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

  seniorPreference = {
    findMany: async (args: {
      where: { seniorId: string };
      orderBy?: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      select?: Record<string, true>;
    }): Promise<Array<{ key: string; value?: string; createdAt?: Date; updatedAt?: Date }>> => {
      const rows = this.preferences.filter((p) => p.seniorId === args.where.seniorId);
      const sorted = args.orderBy ? [...rows].sort((a, b) => a.key.localeCompare(b.key)) : rows;
      // The service either selects {key:true, value:true, createdAt:true,
      // updatedAt:true} (list) or {key:true} (cap-projection). The fake
      // returns the full row shape and the caller's projection narrowing
      // is invisible to the test surface.
      return sorted.map((r) => ({
        key: r.key,
        value: r.value,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    },
    upsert: async (args: {
      where: { seniorId_key: { seniorId: string; key: string } };
      create: { seniorId: string; key: string; value: string };
      update: { value: string };
    }): Promise<{ seniorId: string }> => {
      const existing = this.preferences.find(
        (p) =>
          p.seniorId === args.where.seniorId_key.seniorId && p.key === args.where.seniorId_key.key,
      );
      if (existing === undefined) {
        this.idCounter += 1;
        const now = new Date(2026, 4, 10, 12, 0, 0, this.idCounter);
        this.preferences.push({
          seniorId: args.create.seniorId,
          key: args.create.key,
          value: args.create.value,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        existing.value = args.update.value;
        existing.updatedAt = new Date();
      }
      return { seniorId: args.where.seniorId_key.seniorId };
    },
    deleteMany: async (args: {
      where: { seniorId: string; key: string };
    }): Promise<{ count: number }> => {
      const before = this.preferences.length;
      this.preferences = this.preferences.filter(
        (p) => !(p.seniorId === args.where.seniorId && p.key === args.where.key),
      );
      return { count: before - this.preferences.length };
    },
  };

  $transaction = async <T>(operations: Promise<T>[]): Promise<T[]> => {
    return Promise.all(operations);
  };
}

function newSenior(overrides: Partial<FakeSeniorRow> = {}): FakeSeniorRow {
  return {
    id: `sn_${randomUUID()}`,
    householdId: `hh_${randomUUID()}`,
    deletedAt: null,
    ...overrides,
  };
}

function entries(
  ...e: Array<{ key: string; value: string | null }>
): BulkUpsertSeniorPreferencesRequest {
  return { entries: e };
}

describe('SeniorPreferencesService.list', () => {
  let prisma: FakePrisma;
  let service: SeniorPreferencesService;
  let senior: FakeSeniorRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new SeniorPreferencesService(prisma as any);
    senior = newSenior();
    prisma.seniors.push(senior);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: senior.householdId,
      userId: memberUserId,
      removedAt: null,
    });
  });

  it('returns an empty list when no preferences exist', async () => {
    const result = await service.list({
      seniorId: senior.id,
      requesterUserId: memberUserId,
    });
    expect(result.preferences).toEqual([]);
    expect(result.seniorId).toBe(senior.id);
  });

  it('returns preferences in alphabetical key order', async () => {
    await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries(
        { key: 'sunday_ritual', value: 'Tea with my mother' },
        { key: 'comfort_food', value: 'Tomato soup' },
        { key: 'regional_tradition', value: 'Pittsburgh' },
      ),
    });
    const result = await service.list({
      seniorId: senior.id,
      requesterUserId: memberUserId,
    });
    expect(result.preferences.map((p) => p.key)).toEqual([
      'comfort_food',
      'regional_tradition',
      'sunday_ritual',
    ]);
  });

  it('rejects a stranger with 403', async () => {
    await expect(
      service.list({ seniorId: senior.id, requesterUserId: 'usr_stranger' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 404 when the senior does not exist', async () => {
    await expect(
      service.list({ seniorId: 'sn_missing', requesterUserId: memberUserId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SeniorPreferencesService.bulkUpsert', () => {
  let prisma: FakePrisma;
  let service: SeniorPreferencesService;
  let senior: FakeSeniorRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new SeniorPreferencesService(prisma as any);
    senior = newSenior();
    prisma.seniors.push(senior);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: senior.householdId,
      userId: memberUserId,
      removedAt: null,
    });
  });

  it('inserts new entries', async () => {
    const result = await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries(
        { key: 'comfort_food', value: 'Tomato soup' },
        { key: 'sunday_ritual', value: 'Tea with my mother' },
      ),
    });
    expect(result.preferences).toHaveLength(2);
    const comfort = result.preferences.find((p) => p.key === 'comfort_food');
    expect(comfort?.value).toBe('Tomato soup');
  });

  it('updates an existing key', async () => {
    await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries({ key: 'comfort_food', value: 'Tomato soup' }),
    });
    const result = await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries({ key: 'comfort_food', value: 'Grilled cheese' }),
    });
    expect(result.preferences).toHaveLength(1);
    expect(result.preferences[0]?.value).toBe('Grilled cheese');
  });

  it('deletes an existing key when value is null', async () => {
    await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries(
        { key: 'comfort_food', value: 'Tomato soup' },
        { key: 'sunday_ritual', value: 'Tea' },
      ),
    });
    const result = await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries({ key: 'comfort_food', value: null }),
    });
    expect(result.preferences.map((p) => p.key)).toEqual(['sunday_ritual']);
  });

  it('delete on a missing key is a silent no-op (idempotent)', async () => {
    await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries({ key: 'sunday_ritual', value: 'Tea' }),
    });
    const result = await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries({ key: 'never_set', value: null }),
    });
    expect(result.preferences.map((p) => p.key)).toEqual(['sunday_ritual']);
  });

  it('preserves keys not present in the entries array (merge semantics)', async () => {
    await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries(
        { key: 'comfort_food', value: 'Soup' },
        { key: 'sunday_ritual', value: 'Tea' },
      ),
    });
    const result = await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries({ key: 'cultural_holiday', value: 'Easter' }),
    });
    expect(result.preferences.map((p) => p.key).sort()).toEqual([
      'comfort_food',
      'cultural_holiday',
      'sunday_ritual',
    ]);
  });

  it('rejects an empty entries array with 400', async () => {
    await expect(
      service.bulkUpsert({
        seniorId: senior.id,
        requesterUserId: memberUserId,
        input: entries(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate keys within the same request with 400', async () => {
    await expect(
      service.bulkUpsert({
        seniorId: senior.id,
        requesterUserId: memberUserId,
        input: entries(
          { key: 'comfort_food', value: 'Soup' },
          { key: 'comfort_food', value: 'Grilled cheese' },
        ),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 422 when the request would push the count above the per-senior cap', async () => {
    // Pre-fill with cap-1 keys so a single insert is OK but two would
    // tip over.
    for (let i = 0; i < SENIOR_PREFERENCES_MAX_PER_SENIOR - 1; i++) {
      const now = new Date(2026, 0, 1, 0, 0, 0, i + 1);
      prisma.preferences.push({
        seniorId: senior.id,
        key: `key_${i}`,
        value: `value ${i}`,
        createdAt: now,
        updatedAt: now,
      });
    }
    await expect(
      service.bulkUpsert({
        seniorId: senior.id,
        requesterUserId: memberUserId,
        input: entries({ key: 'one_more', value: 'fits' }, { key: 'two_more', value: 'overflow' }),
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('updates within the cap do not trigger 422 (existing key stays the same count)', async () => {
    for (let i = 0; i < SENIOR_PREFERENCES_MAX_PER_SENIOR; i++) {
      const now = new Date(2026, 0, 1, 0, 0, 0, i + 1);
      prisma.preferences.push({
        seniorId: senior.id,
        key: `key_${i}`,
        value: `value ${i}`,
        createdAt: now,
        updatedAt: now,
      });
    }
    // Updating an existing key keeps the count flat — should succeed.
    const result = await service.bulkUpsert({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: entries({ key: 'key_0', value: 'updated' }),
    });
    const updated = result.preferences.find((p) => p.key === 'key_0');
    expect(updated?.value).toBe('updated');
  });

  it('returns 404 when the senior does not exist', async () => {
    await expect(
      service.bulkUpsert({
        seniorId: 'sn_missing',
        requesterUserId: memberUserId,
        input: entries({ key: 'comfort_food', value: 'Soup' }),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.bulkUpsert({
        seniorId: senior.id,
        requesterUserId: 'usr_stranger',
        input: entries({ key: 'comfort_food', value: 'Soup' }),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
