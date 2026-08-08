import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { PageDetail, PageRecord, PageVersionRecord } from '@taste-and-see/contracts';
import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { PagesService } from '../services/pages.service';
import { PagesController } from './pages.controller';

const TS = '2026-06-30T00:00:00.000Z';

function pageRecord(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id: 'page_1',
    slug: 'privacy',
    status: 'draft',
    title: 'Privacy Policy',
    currentVersionId: null,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

function versionRecord(overrides: Partial<PageVersionRecord> = {}): PageVersionRecord {
  return {
    id: 'ver_1',
    pageId: 'page_1',
    versionNo: 1,
    title: 'Privacy Policy',
    body: 'We respect your privacy.',
    effectiveAt: null,
    isMaterialChange: false,
    materialChangeNote: null,
    createdBy: 'user_admin',
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

interface FakeService {
  listPages: ReturnType<typeof vi.fn>;
  createPage: ReturnType<typeof vi.fn>;
  getPageDetail: ReturnType<typeof vi.fn>;
  appendVersion: ReturnType<typeof vi.fn>;
  getVersion: ReturnType<typeof vi.fn>;
  publishVersion: ReturnType<typeof vi.fn>;
}

function build(overrides: Partial<FakeService> = {}): {
  controller: PagesController;
  service: FakeService;
} {
  const detail: PageDetail = { ...pageRecord(), versions: [versionRecord()] };
  const service: FakeService = {
    listPages: vi.fn(async (): Promise<readonly PageRecord[]> => [pageRecord()]),
    createPage: vi.fn(async () => ({ ok: true, page: pageRecord() })),
    getPageDetail: vi.fn(async () => ({ ok: true, page: detail })),
    appendVersion: vi.fn(async () => ({ ok: true, version: versionRecord() })),
    getVersion: vi.fn(async () => ({ ok: true, version: versionRecord() })),
    publishVersion: vi.fn(async () => ({
      ok: true,
      page: pageRecord({ status: 'published', currentVersionId: 'ver_1' }),
    })),
    ...overrides,
  };
  const controller = new PagesController(service as unknown as PagesService);
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

describe('PagesController.list', () => {
  it('returns the matching pages', async () => {
    const { controller, service } = build();
    const response = await controller.list({ limit: 50 });
    expect(response.pages).toHaveLength(1);
    expect(service.listPages).toHaveBeenCalledWith({ status: undefined, limit: 50 });
  });
});

describe('PagesController.create', () => {
  const body = { slug: 'privacy', title: 'Privacy Policy' };

  it('creates and attributes the actor from the token', async () => {
    const { controller, service } = build();
    const response = await controller.create(body, adminRequest('admin_42'));
    expect(response.page.slug).toBe('privacy');
    expect(service.createPage).toHaveBeenCalledWith(
      expect.objectContaining({
        ...body,
        actorUserId: 'admin_42',
        audit: expect.objectContaining({ actorUserId: 'admin_42', userAgent: 'jest' }),
      }),
    );
  });

  it('maps a slug conflict to 409', async () => {
    const { controller } = build({
      createPage: vi.fn(async () => ({ ok: false, reason: 'slug_conflict' })),
    });
    await expect(controller.create(body, adminRequest())).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a request with no auth context', async () => {
    const { controller } = build();
    await expect(
      controller.create(body, { requestContext: undefined } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PagesController.detail', () => {
  it('returns the page detail with versions', async () => {
    const { controller } = build();
    const response = await controller.detail('page_1');
    expect(response.page.versions).toHaveLength(1);
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getPageDetail: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(controller.detail('page_x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PagesController.appendVersion', () => {
  const body = { title: 'v2', body: 'updated copy' };

  it('appends and threads the actor as createdBy via the service', async () => {
    const { controller, service } = build();
    const response = await controller.appendVersion('page_1', body, adminRequest('admin_9'));
    expect(response.version.id).toBe('ver_1');
    expect(service.appendVersion).toHaveBeenCalledWith(
      expect.objectContaining({ ...body, pageId: 'page_1', actorUserId: 'admin_9' }),
    );
  });

  it('maps page_not_found to 404', async () => {
    const { controller } = build({
      appendVersion: vi.fn(async () => ({ ok: false, reason: 'page_not_found' })),
    });
    await expect(controller.appendVersion('page_x', body, adminRequest())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a request with no auth context (401)', async () => {
    const { controller } = build();
    await expect(
      controller.appendVersion('page_1', body, {
        requestContext: undefined,
      } as unknown as RequestWithContext),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('PagesController.version', () => {
  it('returns the single version', async () => {
    const { controller } = build();
    const response = await controller.version('page_1', 'ver_1');
    expect(response.version.id).toBe('ver_1');
  });

  it('maps not_found to 404', async () => {
    const { controller } = build({
      getVersion: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
    });
    await expect(controller.version('page_1', 'ver_x')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('PagesController.publish', () => {
  it('publishes and returns the published page', async () => {
    const { controller, service } = build();
    const response = await controller.publish('page_1', 'ver_1', {}, adminRequest('publisher_1'));
    expect(response.page.status).toBe('published');
    expect(service.publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: 'page_1', versionId: 'ver_1', effectiveAt: undefined }),
    );
  });

  it('forwards an explicit effectiveAt', async () => {
    const { controller, service } = build();
    await controller.publish(
      'page_1',
      'ver_1',
      { effectiveAt: '2026-12-31T00:00:00.000Z' },
      adminRequest(),
    );
    expect(service.publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveAt: '2026-12-31T00:00:00.000Z' }),
    );
  });

  it('forwards the material-change flag + note to the service (TS-285)', async () => {
    const { controller, service } = build();
    await controller.publish(
      'page_1',
      'ver_1',
      { isMaterialChange: true, materialChangeNote: 'New sub-processor.' },
      adminRequest(),
    );
    expect(service.publishVersion).toHaveBeenCalledWith(
      expect.objectContaining({ isMaterialChange: true, materialChangeNote: 'New sub-processor.' }),
    );
  });

  it('maps page_archived to 409 and version_not_found to 404', async () => {
    const archived = build({
      publishVersion: vi.fn(async () => ({ ok: false, reason: 'page_archived' })),
    });
    await expect(
      archived.controller.publish('page_1', 'ver_1', {}, adminRequest()),
    ).rejects.toBeInstanceOf(ConflictException);

    const missing = build({
      publishVersion: vi.fn(async () => ({ ok: false, reason: 'version_not_found' })),
    });
    await expect(
      missing.controller.publish('page_1', 'ver_x', {}, adminRequest()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
