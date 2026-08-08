import { describe, expect, it, vi, beforeEach } from 'vitest';

import { FakeHelpCategoryPrisma } from '../services/__fixtures__/fake-prisma';
import { HelpCategoryRepository } from './help-category.repository';

let prisma: FakeHelpCategoryPrisma;
let repo: HelpCategoryRepository;

beforeEach(() => {
  prisma = new FakeHelpCategoryPrisma();
  repo = new HelpCategoryRepository(prisma as never);
});

describe('createCategory', () => {
  it('inserts a category and runs onPersist inside the transaction', async () => {
    const onPersist = vi.fn(async () => undefined);
    const category = await repo.createCategory(
      { slug: 'getting-started', name: 'Getting Started', parentId: null, sortOrder: 0 },
      onPersist,
    );

    expect(category.slug).toBe('getting-started');
    expect(category.parentId).toBeNull();
    expect(category.sortOrder).toBe(0);
    expect(onPersist).toHaveBeenCalledWith(prisma, category);
  });

  it('finds a category by id and by slug', async () => {
    const category = await repo.createCategory({
      slug: 'billing',
      name: 'Billing',
      parentId: null,
      sortOrder: 0,
    });
    expect((await repo.findCategory(category.id))?.slug).toBe('billing');
    expect((await repo.findCategoryBySlug('billing'))?.id).toBe(category.id);
    expect(await repo.findCategoryBySlug('missing')).toBeNull();
  });
});

describe('updateCategory', () => {
  it('patches only supplied fields and runs onPersist in-tx', async () => {
    const category = await repo.createCategory({
      slug: 'a',
      name: 'A',
      parentId: null,
      sortOrder: 0,
    });
    const onPersist = vi.fn(async () => undefined);

    const updated = await repo.updateCategory(category.id, { name: 'A2', sortOrder: 3 }, onPersist);
    expect(updated.name).toBe('A2');
    expect(updated.sortOrder).toBe(3);
    expect(onPersist).toHaveBeenCalledWith(prisma, updated);

    // A null parentId promotes to root; an absent field is untouched.
    const promoted = await repo.updateCategory(category.id, { parentId: null });
    expect(promoted.parentId).toBeNull();
    expect(promoted.name).toBe('A2');
  });
});

describe('listCategories', () => {
  it('returns a flat list ordered by (sortOrder, name), honours the limit, filters by parent', async () => {
    const root = await repo.createCategory({
      slug: 'root',
      name: 'Root',
      parentId: null,
      sortOrder: 0,
    });
    await repo.createCategory({ slug: 'b', name: 'B', parentId: root.id, sortOrder: 1 });
    await repo.createCategory({ slug: 'a', name: 'A', parentId: root.id, sortOrder: 0 });

    const children = await repo.listCategories({ parentId: root.id, limit: 500 });
    expect(children.map((c) => c.slug)).toEqual(['a', 'b']);

    const limited = await repo.listCategories({ limit: 1 });
    expect(limited).toHaveLength(1);
  });
});

describe('findChildIds', () => {
  it('returns the direct children ids of a parent', async () => {
    const root = await repo.createCategory({
      slug: 'root',
      name: 'Root',
      parentId: null,
      sortOrder: 0,
    });
    const a = await repo.createCategory({ slug: 'a', name: 'A', parentId: root.id, sortOrder: 0 });
    const b = await repo.createCategory({ slug: 'b', name: 'B', parentId: root.id, sortOrder: 1 });

    const ids = await repo.findChildIds(root.id);
    expect([...ids].sort()).toEqual([a.id, b.id].sort());
    expect(await repo.findChildIds(a.id)).toEqual([]);
  });
});
