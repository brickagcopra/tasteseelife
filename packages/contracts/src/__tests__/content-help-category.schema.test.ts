import { describe, expect, it } from 'vitest';

import {
  CONTENT_HELP_CATEGORIES_LIST_LIMIT_DEFAULT,
  CONTENT_HELP_CATEGORIES_LIST_LIMIT_MAX,
  CONTENT_HELP_CATEGORY_NAME_MAX_LENGTH,
  CONTENT_HELP_CATEGORY_SLUG_MAX_LENGTH,
  CONTENT_HELP_CATEGORY_SORT_ORDER_MAX,
  CreateHelpCategoryRequestSchema,
  HelpCategoryRecordSchema,
  ListHelpCategoriesQuerySchema,
  UpdateHelpCategoryRequestSchema,
} from '../http/content-help-category.schema';

const ISO = '2026-06-30T00:00:00.000Z';

describe('CreateHelpCategoryRequestSchema', () => {
  it('accepts a slug + name, parent + sortOrder optional', () => {
    const parsed = CreateHelpCategoryRequestSchema.parse({
      slug: 'getting-started',
      name: 'Getting Started',
    });
    expect(parsed.slug).toBe('getting-started');
    expect(parsed.parentId).toBeUndefined();
    expect(parsed.sortOrder).toBeUndefined();
  });

  it('accepts an optional parentId + sortOrder', () => {
    const parsed = CreateHelpCategoryRequestSchema.parse({
      slug: 'billing',
      name: 'Billing',
      parentId: 'cat_root',
      sortOrder: 3,
    });
    expect(parsed.parentId).toBe('cat_root');
    expect(parsed.sortOrder).toBe(3);
  });

  it('rejects a non-kebab slug and a blank name', () => {
    expect(
      CreateHelpCategoryRequestSchema.safeParse({ slug: 'Getting Started', name: 'x' }).success,
    ).toBe(false);
    expect(CreateHelpCategoryRequestSchema.safeParse({ slug: 'ok', name: '  ' }).success).toBe(
      false,
    );
  });

  it('rejects an over-long slug / name and a negative sortOrder', () => {
    expect(
      CreateHelpCategoryRequestSchema.safeParse({
        slug: 'a'.repeat(CONTENT_HELP_CATEGORY_SLUG_MAX_LENGTH + 1),
        name: 'x',
      }).success,
    ).toBe(false);
    expect(
      CreateHelpCategoryRequestSchema.safeParse({
        slug: 'ok',
        name: 'a'.repeat(CONTENT_HELP_CATEGORY_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      CreateHelpCategoryRequestSchema.safeParse({ slug: 'ok', name: 'X', sortOrder: -1 }).success,
    ).toBe(false);
    expect(
      CreateHelpCategoryRequestSchema.safeParse({
        slug: 'ok',
        name: 'X',
        sortOrder: CONTENT_HELP_CATEGORY_SORT_ORDER_MAX + 1,
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (.strict)', () => {
    expect(
      CreateHelpCategoryRequestSchema.safeParse({ slug: 'ok', name: 'X', color: 'red' }).success,
    ).toBe(false);
  });
});

describe('UpdateHelpCategoryRequestSchema', () => {
  it('accepts a name-only update', () => {
    expect(UpdateHelpCategoryRequestSchema.parse({ name: 'Renamed' }).name).toBe('Renamed');
  });

  it('accepts a re-parent and an explicit null (promote to root)', () => {
    expect(UpdateHelpCategoryRequestSchema.parse({ parentId: 'cat_2' }).parentId).toBe('cat_2');
    expect(UpdateHelpCategoryRequestSchema.parse({ parentId: null }).parentId).toBeNull();
  });

  it('accepts a sortOrder-only update', () => {
    expect(UpdateHelpCategoryRequestSchema.parse({ sortOrder: 5 }).sortOrder).toBe(5);
  });

  it('rejects an empty body (at least one field required)', () => {
    expect(UpdateHelpCategoryRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a slug rename (slug is immutable)', () => {
    expect(UpdateHelpCategoryRequestSchema.safeParse({ slug: 'renamed' }).success).toBe(false);
  });
});

describe('ListHelpCategoriesQuerySchema', () => {
  it('defaults the limit and coerces a string limit', () => {
    expect(ListHelpCategoriesQuerySchema.parse({}).limit).toBe(
      CONTENT_HELP_CATEGORIES_LIST_LIMIT_DEFAULT,
    );
    expect(ListHelpCategoriesQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('accepts a parentId filter', () => {
    expect(ListHelpCategoriesQuerySchema.parse({ parentId: 'cat_1' }).parentId).toBe('cat_1');
  });

  it('rejects a limit over the max', () => {
    expect(
      ListHelpCategoriesQuerySchema.safeParse({ limit: CONTENT_HELP_CATEGORIES_LIST_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });
});

describe('HelpCategoryRecordSchema', () => {
  const category = {
    id: 'cat_1',
    slug: 'getting-started',
    name: 'Getting Started',
    parentId: null,
    sortOrder: 0,
    createdAt: ISO,
    updatedAt: ISO,
  };

  it('parses a root category record', () => {
    expect(HelpCategoryRecordSchema.parse(category).parentId).toBeNull();
  });

  it('parses a nested category record', () => {
    expect(HelpCategoryRecordSchema.parse({ ...category, parentId: 'cat_root' }).parentId).toBe(
      'cat_root',
    );
  });

  it('rejects an unknown field (.strict)', () => {
    expect(HelpCategoryRecordSchema.safeParse({ ...category, icon: 'x' }).success).toBe(false);
  });
});
