import { describe, expect, it } from 'vitest';

import {
  ClientCreatableMemoryRecipeSourceSchema,
  CreateMemoryRecipeRequestSchema,
  MemoryRecipeSchema,
  MemoryRecipeSourceSchema,
  MemoryRecipesListResponseSchema,
  MEMORY_RECIPE_CUISINE_TAG_MAX_LENGTH,
  MEMORY_RECIPE_DESCRIPTION_MAX_LENGTH,
  MEMORY_RECIPE_IMAGE_KEY_MAX_LENGTH,
  MEMORY_RECIPE_TITLE_MAX_LENGTH,
  MEMORY_RECIPES_MAX_PER_SENIOR,
  UpdateMemoryRecipeRequestSchema,
} from '../http/memory-recipe.schema';

const validRecipe = {
  id: 'mr_abc',
  seniorId: 'sn_abc',
  title: "Bobchi's pierogi",
  description:
    'My grandmother taught me to fold these the summer she stayed with us in 1968. Potato + farmer cheese filling, brown butter on top.',
  source: 'family_contribution',
  cuisineTag: 'eastern_european',
  imageKey: 'memory-recipes/sn_abc/mr_abc/cover.jpg',
  requestedForUpcomingVisit: false,
  contributedByUserId: 'usr_anna',
  sortPosition: 0,
  createdAt: '2026-05-10T12:00:00.000Z',
  updatedAt: '2026-05-10T12:00:00.000Z',
};

describe('MemoryRecipeSourceSchema', () => {
  it('accepts the three canonical values', () => {
    expect(MemoryRecipeSourceSchema.parse('family_contribution')).toBe('family_contribution');
    expect(MemoryRecipeSourceSchema.parse('cultural_catalog')).toBe('cultural_catalog');
    expect(MemoryRecipeSourceSchema.parse('senior_request')).toBe('senior_request');
  });

  it('rejects unknown values', () => {
    expect(MemoryRecipeSourceSchema.safeParse('chef_suggestion').success).toBe(false);
    expect(MemoryRecipeSourceSchema.safeParse('').success).toBe(false);
  });
});

describe('ClientCreatableMemoryRecipeSourceSchema', () => {
  it('accepts only the family-controllable values', () => {
    expect(ClientCreatableMemoryRecipeSourceSchema.parse('family_contribution')).toBe(
      'family_contribution',
    );
    expect(ClientCreatableMemoryRecipeSourceSchema.parse('senior_request')).toBe('senior_request');
  });

  it('rejects cultural_catalog (service-internal only)', () => {
    expect(ClientCreatableMemoryRecipeSourceSchema.safeParse('cultural_catalog').success).toBe(
      false,
    );
  });
});

describe('MemoryRecipeSchema', () => {
  it('round-trips a fully-populated payload', () => {
    expect(MemoryRecipeSchema.parse(validRecipe)).toEqual(validRecipe);
  });

  it('requires the audit + identifier fields', () => {
    const { id: _id, ...withoutId } = validRecipe;
    void _id;
    expect(MemoryRecipeSchema.safeParse(withoutId).success).toBe(false);
    const { createdAt: _c, ...withoutCreatedAt } = validRecipe;
    void _c;
    expect(MemoryRecipeSchema.safeParse(withoutCreatedAt).success).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, surprise: 'field' }).success).toBe(false);
  });

  it('allows null cuisineTag, imageKey, contributedByUserId', () => {
    expect(
      MemoryRecipeSchema.parse({
        ...validRecipe,
        cuisineTag: null,
        imageKey: null,
        contributedByUserId: null,
      }).cuisineTag,
    ).toBeNull();
  });

  it('rejects empty title / description', () => {
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, title: '' }).success).toBe(false);
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, description: '' }).success).toBe(false);
  });

  it('enforces field-length caps', () => {
    const oversizedTitle = 't'.repeat(MEMORY_RECIPE_TITLE_MAX_LENGTH + 1);
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, title: oversizedTitle }).success).toBe(
      false,
    );
    const oversizedDesc = 'd'.repeat(MEMORY_RECIPE_DESCRIPTION_MAX_LENGTH + 1);
    expect(
      MemoryRecipeSchema.safeParse({ ...validRecipe, description: oversizedDesc }).success,
    ).toBe(false);
    const oversizedTag = 'a'.repeat(MEMORY_RECIPE_CUISINE_TAG_MAX_LENGTH + 1);
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, cuisineTag: oversizedTag }).success).toBe(
      false,
    );
    const oversizedImage = 'k'.repeat(MEMORY_RECIPE_IMAGE_KEY_MAX_LENGTH + 1);
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, imageKey: oversizedImage }).success).toBe(
      false,
    );
  });

  it('rejects non-snake_case cuisine tags', () => {
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, cuisineTag: 'Italian' }).success).toBe(
      false,
    );
    expect(
      MemoryRecipeSchema.safeParse({ ...validRecipe, cuisineTag: 'east-european' }).success,
    ).toBe(false);
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, cuisineTag: '1cuisine' }).success).toBe(
      false,
    );
  });

  it('requires sortPosition to be an integer', () => {
    expect(MemoryRecipeSchema.safeParse({ ...validRecipe, sortPosition: 1.5 }).success).toBe(false);
    expect(MemoryRecipeSchema.parse({ ...validRecipe, sortPosition: 0 }).sortPosition).toBe(0);
    expect(MemoryRecipeSchema.parse({ ...validRecipe, sortPosition: -1 }).sortPosition).toBe(-1);
  });
});

describe('CreateMemoryRecipeRequestSchema', () => {
  it('rejects server-owned fields', () => {
    expect(
      CreateMemoryRecipeRequestSchema.safeParse({
        title: 'A',
        description: 'B',
        source: 'family_contribution',
        id: 'mr_should_be_server_issued',
      }).success,
    ).toBe(false);
    expect(
      CreateMemoryRecipeRequestSchema.safeParse({
        title: 'A',
        description: 'B',
        source: 'family_contribution',
        sortPosition: 0,
      }).success,
    ).toBe(false);
    expect(
      CreateMemoryRecipeRequestSchema.safeParse({
        title: 'A',
        description: 'B',
        source: 'family_contribution',
        contributedByUserId: 'usr_x',
      }).success,
    ).toBe(false);
  });

  it('accepts a minimal valid request', () => {
    const parsed = CreateMemoryRecipeRequestSchema.parse({
      title: 'Pierogi',
      description: 'Family recipe',
      source: 'family_contribution',
    });
    expect(parsed.requestedForUpcomingVisit).toBe(false);
    expect(parsed.cuisineTag).toBeUndefined();
    expect(parsed.imageKey).toBeUndefined();
  });

  it('accepts explicit nulls and overrides', () => {
    const parsed = CreateMemoryRecipeRequestSchema.parse({
      title: 'Pierogi',
      description: 'Family recipe',
      source: 'family_contribution',
      cuisineTag: null,
      imageKey: null,
      requestedForUpcomingVisit: true,
    });
    expect(parsed.cuisineTag).toBeNull();
    expect(parsed.imageKey).toBeNull();
    expect(parsed.requestedForUpcomingVisit).toBe(true);
  });

  it('rejects cultural_catalog from clients', () => {
    expect(
      CreateMemoryRecipeRequestSchema.safeParse({
        title: 'A',
        description: 'B',
        source: 'cultural_catalog',
      }).success,
    ).toBe(false);
  });

  it('rejects requests missing the required title/description/source', () => {
    expect(
      CreateMemoryRecipeRequestSchema.safeParse({
        description: 'B',
        source: 'family_contribution',
      }).success,
    ).toBe(false);
    expect(
      CreateMemoryRecipeRequestSchema.safeParse({
        title: 'A',
        source: 'family_contribution',
      }).success,
    ).toBe(false);
    expect(
      CreateMemoryRecipeRequestSchema.safeParse({ title: 'A', description: 'B' }).success,
    ).toBe(false);
  });
});

describe('UpdateMemoryRecipeRequestSchema', () => {
  it('accepts a partial update', () => {
    const parsed = UpdateMemoryRecipeRequestSchema.parse({ requestedForUpcomingVisit: true });
    expect(parsed.requestedForUpcomingVisit).toBe(true);
    expect(parsed.title).toBeUndefined();
  });

  it('accepts the empty object at the contract layer (service rejects)', () => {
    expect(UpdateMemoryRecipeRequestSchema.parse({})).toEqual({});
  });

  it('rejects unknown fields', () => {
    expect(UpdateMemoryRecipeRequestSchema.safeParse({ surprise: 'x' }).success).toBe(false);
  });

  it('rejects source / contributedByUserId attempts (write-once on create)', () => {
    expect(UpdateMemoryRecipeRequestSchema.safeParse({ source: 'cultural_catalog' }).success).toBe(
      false,
    );
    expect(
      UpdateMemoryRecipeRequestSchema.safeParse({ contributedByUserId: 'usr_x' }).success,
    ).toBe(false);
  });

  it('allows clearing cuisineTag / imageKey with explicit null', () => {
    const parsed = UpdateMemoryRecipeRequestSchema.parse({ cuisineTag: null, imageKey: null });
    expect(parsed.cuisineTag).toBeNull();
    expect(parsed.imageKey).toBeNull();
  });

  it('enforces sortPosition integer constraint', () => {
    expect(UpdateMemoryRecipeRequestSchema.safeParse({ sortPosition: 1.5 }).success).toBe(false);
  });
});

describe('MemoryRecipesListResponseSchema', () => {
  it('accepts an empty list', () => {
    expect(MemoryRecipesListResponseSchema.parse({ recipes: [] })).toEqual({ recipes: [] });
  });

  it('accepts multiple recipes', () => {
    const parsed = MemoryRecipesListResponseSchema.parse({
      recipes: [validRecipe, { ...validRecipe, id: 'mr_def', sortPosition: 1, title: 'Borscht' }],
    });
    expect(parsed.recipes).toHaveLength(2);
  });

  it('rejects an unknown top-level field', () => {
    expect(MemoryRecipesListResponseSchema.safeParse({ recipes: [], cursor: 'x' }).success).toBe(
      false,
    );
  });
});

describe('MEMORY_RECIPES_MAX_PER_SENIOR', () => {
  it('is a documented stable cap', () => {
    expect(MEMORY_RECIPES_MAX_PER_SENIOR).toBe(200);
  });
});
