import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AuditActorContext } from '@taste-and-see/nest-audit';
import type { AuditEmitter } from '@taste-and-see/nest-audit';
import { HelpCategoryRepository } from '../repositories/help-category.repository';
import { HelpCategoriesService } from './help-categories.service';
import { FakeHelpCategoryPrisma } from './__fixtures__/fake-prisma';

function actor(): AuditActorContext {
  return {
    actorUserId: 'user_admin',
    actorRole: 'super_admin',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    ip: '203.0.113.5',
    userAgent: 'vitest',
    requestId: 'req_1',
    traceId: null,
  };
}

interface Harness {
  service: HelpCategoriesService;
  prisma: FakeHelpCategoryPrisma;
  emit: ReturnType<typeof vi.fn>;
}

function build(): Harness {
  const prisma = new FakeHelpCategoryPrisma();
  const repo = new HelpCategoryRepository(prisma as never);
  const emit = vi.fn().mockResolvedValue(undefined);
  const audit = { emit } as unknown as AuditEmitter;
  const service = new HelpCategoriesService(repo, audit);
  return { service, prisma, emit };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

async function createRoot(slug: string): Promise<string> {
  const outcome = await h.service.createCategory({
    slug,
    name: slug,
    actorUserId: 'u',
    audit: actor(),
  });
  if (!outcome.ok) throw new Error('precondition');
  return outcome.category.id;
}

describe('createCategory', () => {
  it('creates a root category and emits content_help_category:create in-tx', async () => {
    const outcome = await h.service.createCategory({
      slug: 'getting-started',
      name: 'Getting Started',
      actorUserId: 'user_admin',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.category.slug).toBe('getting-started');
    expect(outcome.category.parentId).toBeNull();
    expect(outcome.category.sortOrder).toBe(0);
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({
      action: 'content_help_category:create',
      resourceKind: 'content_help_category',
    });
    expect(h.emit.mock.calls[0]?.[0]).toBe(h.prisma);
  });

  it('creates a nested category under an existing parent', async () => {
    const rootId = await createRoot('root');
    const outcome = await h.service.createCategory({
      slug: 'child',
      name: 'Child',
      parentId: rootId,
      sortOrder: 2,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.category.parentId).toBe(rootId);
    expect(outcome.ok && outcome.category.sortOrder).toBe(2);
  });

  it('rejects a duplicate slug with slug_conflict and does not audit', async () => {
    await createRoot('dupe');
    h.emit.mockClear();
    const outcome = await h.service.createCategory({
      slug: 'dupe',
      name: 'x',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'slug_conflict' });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('rejects an unknown parent with parent_not_found', async () => {
    const outcome = await h.service.createCategory({
      slug: 'orphan',
      name: 'Orphan',
      parentId: 'missing',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'parent_not_found' });
  });
});

describe('updateCategory', () => {
  it('updates name + sortOrder and emits content_help_category:update', async () => {
    const id = await createRoot('root');
    h.emit.mockClear();

    const outcome = await h.service.updateCategory({
      categoryId: id,
      name: 'Renamed',
      sortOrder: 5,
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.category.name).toBe('Renamed');
    expect(outcome.category.sortOrder).toBe(5);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_help_category:update' });
  });

  it('re-parents under a valid new parent, and promotes to root with null', async () => {
    const a = await createRoot('a');
    const b = await createRoot('b');

    const reparent = await h.service.updateCategory({
      categoryId: b,
      parentId: a,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(reparent.ok && reparent.category.parentId).toBe(a);

    const promote = await h.service.updateCategory({
      categoryId: b,
      parentId: null,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(promote.ok && promote.category.parentId).toBeNull();
  });

  it('returns category_not_found for an unknown category', async () => {
    const outcome = await h.service.updateCategory({
      categoryId: 'missing',
      name: 'x',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'category_not_found' });
  });

  it('returns parent_not_found for an unknown new parent', async () => {
    const id = await createRoot('root');
    const outcome = await h.service.updateCategory({
      categoryId: id,
      parentId: 'missing',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'parent_not_found' });
  });

  it('rejects making a category its own parent (cycle)', async () => {
    const id = await createRoot('root');
    const outcome = await h.service.updateCategory({
      categoryId: id,
      parentId: id,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'cycle' });
  });

  it('rejects re-parenting a category under its own descendant (cycle)', async () => {
    // root ← child ← grandchild ; then try root.parent = grandchild.
    const root = await createRoot('root');
    const child = await h.service.createCategory({
      slug: 'child',
      name: 'c',
      parentId: root,
      actorUserId: 'u',
      audit: actor(),
    });
    if (!child.ok) throw new Error('precondition');
    const grandchild = await h.service.createCategory({
      slug: 'grandchild',
      name: 'g',
      parentId: child.category.id,
      actorUserId: 'u',
      audit: actor(),
    });
    if (!grandchild.ok) throw new Error('precondition');

    const outcome = await h.service.updateCategory({
      categoryId: root,
      parentId: grandchild.category.id,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'cycle' });
    expect(h.emit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: 'content_help_category:update' }),
    );
  });
});

describe('reads', () => {
  it('listCategories returns a flat list ordered by sortOrder then name', async () => {
    await h.service.createCategory({
      slug: 'b',
      name: 'B',
      sortOrder: 1,
      actorUserId: 'u',
      audit: actor(),
    });
    await h.service.createCategory({
      slug: 'a',
      name: 'A',
      sortOrder: 0,
      actorUserId: 'u',
      audit: actor(),
    });

    const all = await h.service.listCategories({ limit: 500 });
    expect(all.map((c) => c.slug)).toEqual(['a', 'b']);
  });

  it('listCategories narrows to a parentId', async () => {
    const root = await createRoot('root');
    await h.service.createCategory({
      slug: 'child',
      name: 'c',
      parentId: root,
      actorUserId: 'u',
      audit: actor(),
    });

    const children = await h.service.listCategories({ parentId: root, limit: 500 });
    expect(children.map((c) => c.slug)).toEqual(['child']);
  });

  it('getCategory returns the node, or not_found', async () => {
    const id = await createRoot('root');
    expect((await h.service.getCategory(id)).ok).toBe(true);
    expect(await h.service.getCategory('missing')).toEqual({ ok: false, reason: 'not_found' });
  });
});
