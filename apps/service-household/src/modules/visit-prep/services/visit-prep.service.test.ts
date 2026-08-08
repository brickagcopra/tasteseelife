import { randomUUID } from 'node:crypto';

import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';

import { VisitPrepService } from './visit-prep.service';

interface FakeSeniorRow {
  id: string;
  dietaryTags: string[];
  allergenTags: string[];
  languageTags: string[];
  mobilityLevel: string;
  dementiaStatus: string;
  intakeCompletedAt: Date | null;
  deletedAt: Date | null;
}

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

/**
 * Minimal Prisma fake — supports the surface VisitPrepService actually
 * uses. Mirrors the per-test seam pattern landed in
 * `memory-recipes.service.test.ts` and `intake.service.test.ts`.
 */
class FakePrisma {
  public seniors: FakeSeniorRow[] = [];
  public recipes: FakeRecipeRow[] = [];

  senior = {
    findFirst: async (args: {
      where: { id: string; deletedAt: null };
      select: Record<string, true>;
    }): Promise<FakeSeniorRow | null> => {
      void args.select;
      const found = this.seniors.find((s) => s.id === args.where.id && s.deletedAt === null);
      return found ?? null;
    },
  };

  memoryRecipe = {
    findMany: async (args: {
      where: { seniorId: string; deletedAt: null };
      orderBy: ReadonlyArray<Record<string, 'asc' | 'desc'>>;
      take: number;
      select: Record<string, true>;
    }): Promise<FakeRecipeRow[]> => {
      void args.select;
      const rows = this.recipes.filter(
        (r) => r.seniorId === args.where.seniorId && r.deletedAt === null,
      );
      // The contract orderBy is [requestedForUpcomingVisit DESC,
      // sortPosition ASC, createdAt ASC]. Sort the fake the same way.
      const sorted = [...rows].sort((a, b) => {
        if (a.requestedForUpcomingVisit !== b.requestedForUpcomingVisit) {
          // true first → DESC
          return a.requestedForUpcomingVisit ? -1 : 1;
        }
        if (a.sortPosition !== b.sortPosition) return a.sortPosition - b.sortPosition;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });
      return sorted.slice(0, args.take);
    },
  };
}

function newSenior(overrides: Partial<FakeSeniorRow> = {}): FakeSeniorRow {
  return {
    id: `sn_${randomUUID()}`,
    dietaryTags: [],
    allergenTags: [],
    languageTags: [],
    mobilityLevel: 'unknown',
    dementiaStatus: 'none',
    intakeCompletedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function newRecipe(seniorId: string, overrides: Partial<FakeRecipeRow> = {}): FakeRecipeRow {
  const now = new Date(2026, 4, 10, 12, 0, 0, Math.floor(Math.random() * 1000));
  return {
    id: `mr_${randomUUID()}`,
    seniorId,
    title: "Bobchi's pierogi",
    description: 'My grandmother taught me to fold these.',
    source: 'family_contribution',
    cuisineTag: null,
    imageKey: null,
    requestedForUpcomingVisit: false,
    contributedByUserId: null,
    sortPosition: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe('VisitPrepService.getSnapshot', () => {
  let prisma: FakePrisma;
  let service: VisitPrepService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new VisitPrepService(
      prisma as unknown as ConstructorParameters<typeof VisitPrepService>[0],
    );
  });

  it('throws 404 when the senior does not exist', async () => {
    await expect(service.getSnapshot({ seniorId: 'sn_missing' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws 404 when the senior is soft-deleted', async () => {
    const senior = newSenior({ deletedAt: new Date() });
    prisma.seniors.push(senior);

    await expect(service.getSnapshot({ seniorId: senior.id })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the operational senior projection + empty recipes when none exist', async () => {
    const senior = newSenior({
      dietaryTags: ['low_sodium', 'soft_textures'],
      allergenTags: ['peanut'],
      languageTags: ['en-US'],
      mobilityLevel: 'aided_cane',
      dementiaStatus: 'mild_cognitive_impairment',
      intakeCompletedAt: new Date('2026-05-01T12:00:00.000Z'),
    });
    prisma.seniors.push(senior);

    const result = await service.getSnapshot({ seniorId: senior.id });

    expect(result.senior).toEqual({
      seniorId: senior.id,
      dietaryTags: ['low_sodium', 'soft_textures'],
      allergenTags: ['peanut'],
      languageTags: ['en-US'],
      mobilityLevel: 'aided_cane',
      dementiaStatus: 'mild_cognitive_impairment',
      intakeCompletedAt: '2026-05-01T12:00:00.000Z',
    });
    expect(result.memoryRecipes).toEqual([]);
  });

  it('serialises a null intakeCompletedAt as null on the wire', async () => {
    const senior = newSenior({ intakeCompletedAt: null });
    prisma.seniors.push(senior);

    const result = await service.getSnapshot({ seniorId: senior.id });

    expect(result.senior.intakeCompletedAt).toBeNull();
  });

  it('orders memory recipes: requested-for-upcoming-visit first, then sortPosition, then createdAt', async () => {
    const senior = newSenior();
    prisma.seniors.push(senior);

    // Three recipes: one requested (should come first), and two not
    // requested in two different sort positions.
    const notRequestedPos2 = newRecipe(senior.id, {
      title: 'Apple pie',
      requestedForUpcomingVisit: false,
      sortPosition: 2,
      createdAt: new Date('2026-05-01T10:00:00.000Z'),
    });
    const notRequestedPos1 = newRecipe(senior.id, {
      title: 'Bread pudding',
      requestedForUpcomingVisit: false,
      sortPosition: 1,
      createdAt: new Date('2026-05-01T11:00:00.000Z'),
    });
    const requested = newRecipe(senior.id, {
      title: "Bobchi's pierogi",
      requestedForUpcomingVisit: true,
      sortPosition: 5,
      createdAt: new Date('2026-05-01T12:00:00.000Z'),
    });
    prisma.recipes.push(notRequestedPos2, notRequestedPos1, requested);

    const result = await service.getSnapshot({ seniorId: senior.id });

    expect(result.memoryRecipes.map((r) => r.title)).toEqual([
      "Bobchi's pierogi",
      'Bread pudding',
      'Apple pie',
    ]);
  });

  it('excludes soft-deleted recipes', async () => {
    const senior = newSenior();
    prisma.seniors.push(senior);

    prisma.recipes.push(
      newRecipe(senior.id, { title: 'Visible' }),
      newRecipe(senior.id, { title: 'Hidden', deletedAt: new Date() }),
    );

    const result = await service.getSnapshot({ seniorId: senior.id });

    expect(result.memoryRecipes.map((r) => r.title)).toEqual(['Visible']);
  });

  it('does not return recipes belonging to a different senior', async () => {
    const senior1 = newSenior();
    const senior2 = newSenior();
    prisma.seniors.push(senior1, senior2);
    prisma.recipes.push(
      newRecipe(senior1.id, { title: 'Senior 1 dish' }),
      newRecipe(senior2.id, { title: 'Senior 2 dish' }),
    );

    const result = await service.getSnapshot({ seniorId: senior1.id });

    expect(result.memoryRecipes).toHaveLength(1);
    expect(result.memoryRecipes[0]?.title).toBe('Senior 1 dish');
  });

  it('slices the recipes array at VISIT_PREP_MEMORY_RECIPES_MAX (24) — proven by the take arg being honoured', async () => {
    const senior = newSenior();
    prisma.seniors.push(senior);

    // Insert 30 recipes; the fake honours the `take` arg.
    for (let i = 0; i < 30; i += 1) {
      prisma.recipes.push(
        newRecipe(senior.id, {
          title: `Recipe ${i}`,
          sortPosition: i,
          createdAt: new Date(2026, 4, 10, 12, 0, 0, i),
        }),
      );
    }

    const result = await service.getSnapshot({ seniorId: senior.id });

    expect(result.memoryRecipes).toHaveLength(24);
    expect(result.memoryRecipes.map((r) => r.title)).toEqual(
      Array.from({ length: 24 }, (_, idx) => `Recipe ${idx}`),
    );
  });

  it('projects the senior id through to the DTO', async () => {
    const senior = newSenior({ id: 'sn_known_abc' });
    prisma.seniors.push(senior);

    const result = await service.getSnapshot({ seniorId: senior.id });

    expect(result.senior.seniorId).toBe('sn_known_abc');
  });

  it('preserves multi-element tag arrays without re-ordering them', async () => {
    const senior = newSenior({
      dietaryTags: ['vegan', 'gluten_free', 'low_sodium'],
      allergenTags: ['peanut', 'shellfish'],
      languageTags: ['en-US', 'es', 'zh-CN'],
    });
    prisma.seniors.push(senior);

    const result = await service.getSnapshot({ seniorId: senior.id });

    expect(result.senior.dietaryTags).toEqual(['vegan', 'gluten_free', 'low_sodium']);
    expect(result.senior.allergenTags).toEqual(['peanut', 'shellfish']);
    expect(result.senior.languageTags).toEqual(['en-US', 'es', 'zh-CN']);
  });
});
