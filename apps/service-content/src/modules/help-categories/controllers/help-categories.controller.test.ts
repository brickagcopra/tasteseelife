import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { HelpCategoryRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { HelpCategoriesService } from '../services/help-categories.service';
import { HelpCategoriesController } from './help-categories.controller';

const TS = '2026-06-30T00:00:00.000Z';

function categoryRecord(overrides: Partial<HelpCategoryRecord> = {}): HelpCategoryRecord {
  return {
    id: 'cat_1',
    slug: 'getting-started',
    name: 'Getting Started',
    parentId: null,
    sortOrder: 0,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

interface FakeService {
  listCategories: ReturnType<typeof vi.fn>;
  createCategory: ReturnType<typeof vi.fn>;
  getCategory: ReturnType<typeof vi.fn>;
  updateCategory: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: HelpCategoriesController;
  service: FakeService;
} {
  const service: FakeService = {
    listCategories: vi.fn(async (): Promise<readonly HelpCategoryRecord[]> => [categoryRecord()]),
    createCategory: vi.fn(async () => ({ ok: true, category: categoryRecord() })),
    getCategory: vi.fn(async () => ({ ok: true, category: categoryRecord() })),
    updateCategory: vi.fn(async () => ({
      ok: true,
      category: categoryRecord({ name: 'Renamed' }),
    })),
    ...overrides,
  };
  const controller = new HelpCategoriesController(service as unknown as HelpCategoriesService);
  return { controller, service };
}

function adminRequest(userId = 'user_admin'): RequestWithContext {
  const ctx: RequestContext = {
    userId,
    mfaVerified: true,
    roles: [],
    tenantScope: { type: 'global' },
  };
  return {
    requestContext: ctx,
    ip: '203.0.113.9',
    headers: { 'user-agent': 'jest', 'x-request-id': 'req_test' },
  } as unknown as RequestWithContext;
}

describe('HelpCategoriesController.list', () => {
  it('returns matching categories and forwards the parent filter', async () => {
    const { controller, service } = build();
    const response = await controller.list({ limit: 500, parentId: 'cat_root' });
    expect(response.categories).toHaveLength(1);
    expect(service.listCategories).toHaveBeenCalledWith({ parentId: 'cat_root', limit: 500 });
  });
});

describe('HelpCategoriesController.create', () => {
  const body = { slug: 'getting-started', name: 'Getting Started' };

  it('creates and attributes the actor from the token', async () => {
    const { controller, service } = build();
    const response = await controller.create(body, adminRequest('admin_42'));
    expect(response.category.slug).toBe('getting-started');
    expect(service.createCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        actorUserId: 'admin_42',
        audit: expect.objectContaining({ actorUserId: 'admin_42', userAgent: 'jest' }),
      }),
    );
  });

  it('maps a slug conflict to 409 and a bad parent to 404', async () => {
    const conflict = build({
      createCategory: vi.fn(async () => ({ ok: false, reason: 'slug_conflict' })),
    });
    await expect(conflict.controller.create(body, adminRequest())).rejects.toBeInstanceOf(
      ConflictException,
    );

    const badParent = build({
      createCategory: vi.fn(async () => ({ ok: false, reason: 'parent_not_found' })),
    });
    await expect(
      badParent.controller.create({ ...body, parentId: 'missing' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(
      controller.create(body, { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('HelpCategoriesController.detail', () => {
  it('returns the category', async () => {
    const { controller } = build();
    const response = await controller.detail('cat_1');
    expect(response.category.id).toBe('cat_1');
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getCategory: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(controller.detail('cat_x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('HelpCategoriesController.update', () => {
  it('updates and forwards the actor', async () => {
    const { controller, service } = build();
    const response = await controller.update('cat_1', { name: 'Renamed' }, adminRequest('admin_9'));
    expect(response.category.name).toBe('Renamed');
    expect(service.updateCategory).toHaveBeenCalledWith(
      expect.objectContaining({ categoryId: 'cat_1', name: 'Renamed', actorUserId: 'admin_9' }),
    );
  });

  it('maps category_not_found/parent_not_found to 404 and cycle to 409', async () => {
    const missing = build({
      updateCategory: vi.fn(async () => ({ ok: false, reason: 'category_not_found' })),
    });
    await expect(
      missing.controller.update('cat_x', { name: 'x' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const badParent = build({
      updateCategory: vi.fn(async () => ({ ok: false, reason: 'parent_not_found' })),
    });
    await expect(
      badParent.controller.update('cat_1', { parentId: 'missing' }, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);

    const cycle = build({ updateCategory: vi.fn(async () => ({ ok: false, reason: 'cycle' })) });
    await expect(
      cycle.controller.update('cat_1', { parentId: 'cat_desc' }, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a request with no auth context (401)', async () => {
    const { controller } = build();
    await expect(
      controller.update('cat_1', { name: 'x' }, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
