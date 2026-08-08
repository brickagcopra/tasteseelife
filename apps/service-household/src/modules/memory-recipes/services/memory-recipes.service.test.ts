import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  MEMORY_RECIPES_MAX_PER_SENIOR,
  type CreateMemoryRecipeRequest,
  type UpdateMemoryRecipeRequest,
} from '@taste-and-see/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { MemoryRecipesService } from './memory-recipes.service';

interface FakeRecipeRow {
  id: string;
  seniorId: string;
  title: string;
  description: string;
  source: string;
  cuisineTag: string | null;
  imageKey: string | null;
  requestedForUpcomingVisit: boolean;
  contributedByUserId: string | null;
  sortPosition: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
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
 * Minimal Prisma fake — supports the surface MemoryRecipesService
 * actually uses. Mirrors the EmergencyContacts test seam precisely:
 * `update` filters out `undefined` values to match Prisma's
 * "don't touch this column" semantics; `findMany` applies the
 * orderBy contract clauses.
 */
class FakePrisma {
  public seniors: FakeSeniorRow[] = [];
  public memberships: FakeMembership[] = [];
  public recipes: FakeRecipeRow[] = [];
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

  memoryRecipe = {
    findFirst: async (args: {
      where: {
        id: string;
        seniorId: string;
        deletedAt?: null;
      };
    }): Promise<FakeRecipeRow | null> => {
      const found = this.recipes.find((r) => {
        if (r.id !== args.where.id) return false;
        if (r.seniorId !== args.where.seniorId) return false;
        if (args.where.deletedAt === null && r.deletedAt !== null) return false;
        return true;
      });
      return found ?? null;
    },
    findMany: async (args: {
      where: { seniorId: string; deletedAt: null };
      orderBy: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
    }): Promise<FakeRecipeRow[]> => {
      const rows = this.recipes.filter(
        (r) => r.seniorId === args.where.seniorId && r.deletedAt === null,
      );
      // Apply the sortPosition-then-createdAt ascending sort the
      // service requests.
      return [...rows].sort((a, b) => {
        if (a.sortPosition !== b.sortPosition) return a.sortPosition - b.sortPosition;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
    },
    count: async (args: { where: { seniorId: string; deletedAt: null } }): Promise<number> => {
      return this.recipes.filter((r) => r.seniorId === args.where.seniorId && r.deletedAt === null)
        .length;
    },
    aggregate: async (args: {
      where: { seniorId: string; deletedAt: null };
      _max: { sortPosition: true };
    }): Promise<{ _max: { sortPosition: number | null } }> => {
      const rows = this.recipes.filter(
        (r) => r.seniorId === args.where.seniorId && r.deletedAt === null,
      );
      if (rows.length === 0) return { _max: { sortPosition: null } };
      const max = Math.max(...rows.map((r) => r.sortPosition));
      return { _max: { sortPosition: max } };
    },
    create: async (args: {
      data: {
        seniorId: string;
        title: string;
        description: string;
        source: string;
        cuisineTag: string | null;
        imageKey: string | null;
        requestedForUpcomingVisit: boolean;
        contributedByUserId: string | null;
        sortPosition: number;
      };
    }): Promise<FakeRecipeRow> => {
      this.idCounter += 1;
      const now = new Date(2026, 4, 10, 12, 0, 0, this.idCounter);
      const row: FakeRecipeRow = {
        id: `mr_${this.idCounter}_${randomUUID()}`,
        seniorId: args.data.seniorId,
        title: args.data.title,
        description: args.data.description,
        source: args.data.source,
        cuisineTag: args.data.cuisineTag,
        imageKey: args.data.imageKey,
        requestedForUpcomingVisit: args.data.requestedForUpcomingVisit,
        contributedByUserId: args.data.contributedByUserId,
        sortPosition: args.data.sortPosition,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.recipes.push(row);
      return row;
    },
    update: async (args: {
      where: { id: string };
      data: Partial<FakeRecipeRow>;
    }): Promise<FakeRecipeRow> => {
      const row = this.recipes.find((r) => r.id === args.where.id);
      if (row === undefined) throw new Error('recipe row missing in fake');
      const writable = row as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined) continue;
        writable[key] = value;
      }
      row.updatedAt = new Date();
      return row;
    },
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

function createInput(
  overrides: Partial<CreateMemoryRecipeRequest> = {},
): CreateMemoryRecipeRequest {
  return {
    title: "Bobchi's pierogi",
    description: 'My grandmother taught me to fold these.',
    source: 'family_contribution',
    // The Zod schema gives `requestedForUpcomingVisit` a `.default(false)`,
    // which makes the inferred TS output type require the field even
    // though the input shape allows omission. Set the default explicitly
    // here so the test fixture matches the post-parse contract type.
    requestedForUpcomingVisit: false,
    ...overrides,
  };
}

describe('MemoryRecipesService.list', () => {
  let prisma: FakePrisma;
  let service: MemoryRecipesService;
  let senior: FakeSeniorRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam: narrow Prisma surface only.
    service = new MemoryRecipesService(prisma as any);
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

  it('returns an empty list when no recipes exist', async () => {
    const result = await service.list({
      seniorId: senior.id,
      requesterUserId: memberUserId,
    });
    expect(result.recipes).toEqual([]);
  });

  it('returns recipes in sortPosition-then-createdAt order, filtering soft-deleted', async () => {
    await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'Third' }),
    });
    await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'First' }),
    });
    await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'Second' }),
    });
    // Reorder via update (Second goes to position 0; First goes to 1).
    const second = prisma.recipes.find((r) => r.title === 'Second');
    if (second === undefined) throw new Error('fixture missing');
    const first = prisma.recipes.find((r) => r.title === 'First');
    if (first === undefined) throw new Error('fixture missing');
    second.sortPosition = 0;
    first.sortPosition = 1;
    // Soft-delete the third.
    const third = prisma.recipes.find((r) => r.title === 'Third');
    if (third === undefined) throw new Error('fixture missing');
    third.deletedAt = new Date();

    const result = await service.list({
      seniorId: senior.id,
      requesterUserId: memberUserId,
    });
    expect(result.recipes.map((r) => r.title)).toEqual(['Second', 'First']);
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

  it('returns 404 when the senior is soft-deleted', async () => {
    senior.deletedAt = new Date();
    await expect(
      service.list({ seniorId: senior.id, requesterUserId: memberUserId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MemoryRecipesService.create', () => {
  let prisma: FakePrisma;
  let service: MemoryRecipesService;
  let senior: FakeSeniorRow;
  let memberUserId: string;

  beforeEach(() => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new MemoryRecipesService(prisma as any);
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

  it('persists a new recipe and returns the DTO', async () => {
    const result = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput(),
    });
    expect(result.title).toBe("Bobchi's pierogi");
    expect(result.seniorId).toBe(senior.id);
    expect(result.cuisineTag).toBeNull();
    expect(result.imageKey).toBeNull();
    expect(result.requestedForUpcomingVisit).toBe(false);
    expect(prisma.recipes).toHaveLength(1);
  });

  it('sets contributedByUserId only when source is family_contribution', async () => {
    const family = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ source: 'family_contribution' }),
    });
    expect(family.contributedByUserId).toBe(memberUserId);

    const request = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ source: 'senior_request' }),
    });
    expect(request.contributedByUserId).toBeNull();
  });

  it('auto-assigns sortPosition starting at 0 and incrementing', async () => {
    const first = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'A' }),
    });
    const second = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'B' }),
    });
    const third = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'C' }),
    });
    expect(first.sortPosition).toBe(0);
    expect(second.sortPosition).toBe(1);
    expect(third.sortPosition).toBe(2);
  });

  it('soft-deleted recipes do not reserve sortPosition slots', async () => {
    const first = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'A' }),
    });
    const second = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'B' }),
    });
    expect(second.sortPosition).toBe(1);
    // Soft-delete the second; the next create should fill position 1
    // (max active is now first.sortPosition = 0; next is 1).
    const row = prisma.recipes.find((r) => r.id === second.id);
    if (row === undefined) throw new Error('fixture missing');
    row.deletedAt = new Date();
    void first;
    const third = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput({ title: 'C' }),
    });
    expect(third.sortPosition).toBe(1);
  });

  it('throws 422 when the senior is at the recipes cap', async () => {
    // Stuff the cap directly into the fake (cheaper than 200 service calls).
    for (let i = 0; i < MEMORY_RECIPES_MAX_PER_SENIOR; i++) {
      const now = new Date(2026, 0, 1, 0, 0, 0, i + 1);
      prisma.recipes.push({
        id: `mr_seed_${i}_${randomUUID()}`,
        seniorId: senior.id,
        title: `seed ${i}`,
        description: 'seed',
        source: 'family_contribution',
        cuisineTag: null,
        imageKey: null,
        requestedForUpcomingVisit: false,
        contributedByUserId: memberUserId,
        sortPosition: i,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }
    await expect(
      service.create({
        seniorId: senior.id,
        requesterUserId: memberUserId,
        input: createInput({ title: 'Overflow' }),
      }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('returns 404 when the senior does not exist', async () => {
    await expect(
      service.create({
        seniorId: 'sn_missing',
        requesterUserId: memberUserId,
        input: createInput(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.create({
        seniorId: senior.id,
        requesterUserId: 'usr_stranger',
        input: createInput(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('MemoryRecipesService.update', () => {
  let prisma: FakePrisma;
  let service: MemoryRecipesService;
  let senior: FakeSeniorRow;
  let memberUserId: string;
  let recipeId: string;

  beforeEach(async () => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new MemoryRecipesService(prisma as any);
    senior = newSenior();
    prisma.seniors.push(senior);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: senior.householdId,
      userId: memberUserId,
      removedAt: null,
    });
    const created = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput(),
    });
    recipeId = created.id;
  });

  it('patches a single field', async () => {
    const result = await service.update({
      seniorId: senior.id,
      recipeId,
      requesterUserId: memberUserId,
      input: { requestedForUpcomingVisit: true } satisfies UpdateMemoryRecipeRequest,
    });
    expect(result.requestedForUpcomingVisit).toBe(true);
    expect(result.title).toBe("Bobchi's pierogi"); // untouched
  });

  it('clears cuisineTag / imageKey when set to null', async () => {
    await service.update({
      seniorId: senior.id,
      recipeId,
      requesterUserId: memberUserId,
      input: { cuisineTag: 'eastern_european', imageKey: 'memory-recipes/cover.jpg' },
    });
    const cleared = await service.update({
      seniorId: senior.id,
      recipeId,
      requesterUserId: memberUserId,
      input: { cuisineTag: null, imageKey: null },
    });
    expect(cleared.cuisineTag).toBeNull();
    expect(cleared.imageKey).toBeNull();
  });

  it('rejects an empty patch with 400', async () => {
    await expect(
      service.update({
        seniorId: senior.id,
        recipeId,
        requesterUserId: memberUserId,
        input: {},
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 when the recipe does not exist', async () => {
    await expect(
      service.update({
        seniorId: senior.id,
        recipeId: 'mr_missing',
        requesterUserId: memberUserId,
        input: { requestedForUpcomingVisit: true },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the recipe belongs to a different senior', async () => {
    const otherSenior = newSenior();
    prisma.seniors.push(otherSenior);
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: otherSenior.householdId,
      userId: memberUserId,
      removedAt: null,
    });
    await expect(
      service.update({
        seniorId: otherSenior.id,
        recipeId,
        requesterUserId: memberUserId,
        input: { requestedForUpcomingVisit: true },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 when the recipe is soft-deleted', async () => {
    const row = prisma.recipes.find((r) => r.id === recipeId);
    if (row === undefined) throw new Error('fixture missing');
    row.deletedAt = new Date();
    await expect(
      service.update({
        seniorId: senior.id,
        recipeId,
        requesterUserId: memberUserId,
        input: { requestedForUpcomingVisit: true },
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.update({
        seniorId: senior.id,
        recipeId,
        requesterUserId: 'usr_stranger',
        input: { requestedForUpcomingVisit: true },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('MemoryRecipesService.remove', () => {
  let prisma: FakePrisma;
  let service: MemoryRecipesService;
  let senior: FakeSeniorRow;
  let memberUserId: string;
  let recipeId: string;

  beforeEach(async () => {
    prisma = new FakePrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test seam.
    service = new MemoryRecipesService(prisma as any);
    senior = newSenior();
    prisma.seniors.push(senior);
    memberUserId = `usr_${randomUUID()}`;
    prisma.memberships.push({
      id: `mem_${randomUUID()}`,
      householdId: senior.householdId,
      userId: memberUserId,
      removedAt: null,
    });
    const created = await service.create({
      seniorId: senior.id,
      requesterUserId: memberUserId,
      input: createInput(),
    });
    recipeId = created.id;
  });

  it('soft-deletes the row', async () => {
    await service.remove({
      seniorId: senior.id,
      recipeId,
      requesterUserId: memberUserId,
    });
    const row = prisma.recipes.find((r) => r.id === recipeId);
    expect(row?.deletedAt).not.toBeNull();
  });

  it('is idempotent on a previously-deleted row', async () => {
    await service.remove({
      seniorId: senior.id,
      recipeId,
      requesterUserId: memberUserId,
    });
    await expect(
      service.remove({
        seniorId: senior.id,
        recipeId,
        requesterUserId: memberUserId,
      }),
    ).resolves.toBeUndefined();
  });

  it('returns 404 when the recipe does not exist', async () => {
    await expect(
      service.remove({
        seniorId: senior.id,
        recipeId: 'mr_missing',
        requesterUserId: memberUserId,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 403 when the requester is not a household member', async () => {
    await expect(
      service.remove({
        seniorId: senior.id,
        recipeId,
        requesterUserId: 'usr_stranger',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
