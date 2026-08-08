import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AuditActorContext } from '@taste-and-see/nest-audit';
import type { AuditEmitter } from '@taste-and-see/nest-audit';
import type { ContentLegalEmitter } from '../../audit/content-legal-emitter';
import { PageRepository } from '../repositories/page.repository';
import { PagesService } from './pages.service';
import { FakeContentPrisma } from './__fixtures__/fake-prisma';

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
  service: PagesService;
  prisma: FakeContentPrisma;
  emit: ReturnType<typeof vi.fn>;
  legalEmit: ReturnType<typeof vi.fn>;
}

function build(): Harness {
  const prisma = new FakeContentPrisma();
  const repo = new PageRepository(prisma as never);
  const emit = vi.fn().mockResolvedValue(undefined);
  const audit = { emit } as unknown as AuditEmitter;
  const legalEmit = vi.fn().mockResolvedValue(undefined);
  const legal = { emit: legalEmit } as unknown as ContentLegalEmitter;
  const service = new PagesService(repo, audit, legal);
  return { service, prisma, emit, legalEmit };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('createPage', () => {
  it('creates a draft page and emits a content_page:create audit event in-tx', async () => {
    const outcome = await h.service.createPage({
      slug: 'privacy',
      title: 'Privacy Policy',
      actorUserId: 'user_admin',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.slug).toBe('privacy');
    expect(outcome.page.status).toBe('draft');
    expect(outcome.page.currentVersionId).toBeNull();
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({
      action: 'content_page:create',
      resourceKind: 'content_page',
    });
    // The tx client (1st arg) is the fake prisma itself — proves emission runs
    // inside the create transaction.
    expect(h.emit.mock.calls[0]?.[0]).toBe(h.prisma);
  });

  it('rejects a duplicate slug with slug_conflict and does not audit', async () => {
    await h.service.createPage({ slug: 'terms', title: 'Terms', actorUserId: 'u', audit: actor() });
    h.emit.mockClear();

    const outcome = await h.service.createPage({
      slug: 'terms',
      title: 'Terms v2',
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome).toEqual({ ok: false, reason: 'slug_conflict' });
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.prisma.pages).toHaveLength(1);
  });
});

describe('appendVersion', () => {
  it('assigns monotonically-increasing version numbers per page', async () => {
    const page = await h.service.createPage({
      slug: 'about',
      title: 'About',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!page.ok) throw new Error('precondition');

    const v1 = await h.service.appendVersion({
      pageId: page.page.id,
      title: 'About v1',
      body: 'first',
      actorUserId: 'author_1',
      audit: actor(),
    });
    const v2 = await h.service.appendVersion({
      pageId: page.page.id,
      title: 'About v2',
      body: 'second',
      actorUserId: 'author_1',
      audit: actor(),
    });

    expect(v1.ok && v1.version.versionNo).toBe(1);
    expect(v2.ok && v2.version.versionNo).toBe(2);
    expect(v1.ok && v1.version.createdBy).toBe('author_1');
    expect(v1.ok && v1.version.effectiveAt).toBeNull();
  });

  it('emits content_page_version:create on append', async () => {
    const page = await h.service.createPage({
      slug: 'press',
      title: 'Press',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!page.ok) throw new Error('precondition');
    h.emit.mockClear();

    await h.service.appendVersion({
      pageId: page.page.id,
      title: 'Press v1',
      body: 'hello',
      actorUserId: 'u',
      audit: actor(),
    });

    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_page_version:create' });
  });

  it('returns page_not_found for an unknown page', async () => {
    const outcome = await h.service.appendVersion({
      pageId: 'missing',
      title: 't',
      body: 'b',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'page_not_found' });
  });
});

describe('publishVersion', () => {
  async function seedPageWithVersion(): Promise<{ pageId: string; versionId: string }> {
    const page = await h.service.createPage({
      slug: 'cookie',
      title: 'Cookie',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!page.ok) throw new Error('precondition');
    const version = await h.service.appendVersion({
      pageId: page.page.id,
      title: 'Cookie v1',
      body: 'crumbs',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!version.ok) throw new Error('precondition');
    return { pageId: page.page.id, versionId: version.version.id };
  }

  it('flips the page to published, repoints currentVersionId, and stamps effectiveAt', async () => {
    const { pageId, versionId } = await seedPageWithVersion();
    h.emit.mockClear();

    const outcome = await h.service.publishVersion({
      pageId,
      versionId,
      effectiveAt: undefined,
      actorUserId: 'publisher',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.status).toBe('published');
    expect(outcome.page.currentVersionId).toBe(versionId);

    const versionRow = h.prisma.versions.find((v) => v['id'] === versionId);
    expect(versionRow?.['effectiveAt']).toBeInstanceOf(Date);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_page:publish' });
  });

  it('an ordinary (non-material) publish does NOT emit the material-change event but still audits', async () => {
    const { pageId, versionId } = await seedPageWithVersion();
    h.emit.mockClear();
    h.legalEmit.mockClear();

    await h.service.publishVersion({
      pageId,
      versionId,
      effectiveAt: undefined,
      actorUserId: 'publisher',
      audit: actor(),
    });

    // Audit fires; the material-change event does not.
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_page:publish' });
    expect(h.legalEmit).not.toHaveBeenCalled();

    const versionRow = h.prisma.versions.find((v) => v['id'] === versionId);
    expect(versionRow?.['isMaterialChange']).toBe(false);
    expect(versionRow?.['materialChangeNote']).toBeNull();
  });

  it('a MATERIAL publish emits content.page.material_changed in-tx, persists the flag+note, and still audits', async () => {
    const { pageId, versionId } = await seedPageWithVersion();
    h.emit.mockClear();
    h.legalEmit.mockClear();

    const outcome = await h.service.publishVersion({
      pageId,
      versionId,
      effectiveAt: undefined,
      isMaterialChange: true,
      materialChangeNote: 'Updated data-retention clause; new sub-processor added.',
      actorUserId: 'publisher',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    // Audit AND the material-change event both fire.
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_page:publish' });
    expect(h.legalEmit).toHaveBeenCalledTimes(1);
    // The domain event runs inside the publish transaction (1st arg = the tx client).
    expect(h.legalEmit.mock.calls[0]?.[0]).toBe(h.prisma);
    expect(h.legalEmit.mock.calls[0]?.[1]).toMatchObject({
      pageId,
      pageVersionId: versionId,
      slug: 'cookie',
      versionNo: 1,
      materialChangeNote: 'Updated data-retention clause; new sub-processor added.',
    });

    // The flag + note are persisted on the version row.
    const versionRow = h.prisma.versions.find((v) => v['id'] === versionId);
    expect(versionRow?.['isMaterialChange']).toBe(true);
    expect(versionRow?.['materialChangeNote']).toBe(
      'Updated data-retention clause; new sub-processor added.',
    );
  });

  it('a material publish with the flag but NO note emits a null note', async () => {
    const { pageId, versionId } = await seedPageWithVersion();
    h.legalEmit.mockClear();

    await h.service.publishVersion({
      pageId,
      versionId,
      effectiveAt: undefined,
      isMaterialChange: true,
      actorUserId: 'publisher',
      audit: actor(),
    });

    expect(h.legalEmit.mock.calls[0]?.[1]).toMatchObject({ materialChangeNote: null });
    const versionRow = h.prisma.versions.find((v) => v['id'] === versionId);
    expect(versionRow?.['materialChangeNote']).toBeNull();
  });

  it('honours an explicit (future / backdated) effectiveAt', async () => {
    const { pageId, versionId } = await seedPageWithVersion();

    await h.service.publishVersion({
      pageId,
      versionId,
      effectiveAt: '2026-12-31T00:00:00.000Z',
      actorUserId: 'publisher',
      audit: actor(),
    });

    const versionRow = h.prisma.versions.find((v) => v['id'] === versionId);
    expect((versionRow?.['effectiveAt'] as Date).toISOString()).toBe('2026-12-31T00:00:00.000Z');
  });

  it('returns page_not_found / version_not_found / page_archived in precedence order', async () => {
    const { pageId, versionId } = await seedPageWithVersion();

    expect(
      await h.service.publishVersion({
        pageId: 'missing',
        versionId,
        effectiveAt: undefined,
        actorUserId: 'u',
        audit: actor(),
      }),
    ).toEqual({ ok: false, reason: 'page_not_found' });

    expect(
      await h.service.publishVersion({
        pageId,
        versionId: 'missing',
        effectiveAt: undefined,
        actorUserId: 'u',
        audit: actor(),
      }),
    ).toEqual({ ok: false, reason: 'version_not_found' });

    // Archive the page, then publish must be blocked.
    const pageRow = h.prisma.pages.find((p) => p['id'] === pageId);
    if (pageRow !== undefined) pageRow['status'] = 'archived';
    expect(
      await h.service.publishVersion({
        pageId,
        versionId,
        effectiveAt: undefined,
        actorUserId: 'u',
        audit: actor(),
      }),
    ).toEqual({ ok: false, reason: 'page_archived' });
  });
});

describe('reads', () => {
  it('listPages returns newest-first and filters by status', async () => {
    const p1 = await h.service.createPage({
      slug: 'a',
      title: 'A',
      actorUserId: 'u',
      audit: actor(),
    });
    await h.service.createPage({ slug: 'b', title: 'B', actorUserId: 'u', audit: actor() });
    if (!p1.ok) throw new Error('precondition');

    const all = await h.service.listPages({ limit: 50 });
    expect(all.map((p) => p.slug)).toEqual(['b', 'a']);

    const published = await h.service.listPages({ status: 'published', limit: 50 });
    expect(published).toHaveLength(0);
  });

  it('getPageDetail returns the page with versions newest-first, or not_found', async () => {
    const page = await h.service.createPage({
      slug: 'about',
      title: 'About',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!page.ok) throw new Error('precondition');
    await h.service.appendVersion({
      pageId: page.page.id,
      title: 'v1',
      body: '1',
      actorUserId: 'u',
      audit: actor(),
    });
    await h.service.appendVersion({
      pageId: page.page.id,
      title: 'v2',
      body: '2',
      actorUserId: 'u',
      audit: actor(),
    });

    const detail = await h.service.getPageDetail(page.page.id);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.page.versions.map((v) => v.versionNo)).toEqual([2, 1]);

    expect(await h.service.getPageDetail('missing')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('getVersion scopes to the page and 404s a cross-page id', async () => {
    const page = await h.service.createPage({
      slug: 'about',
      title: 'About',
      actorUserId: 'u',
      audit: actor(),
    });
    const other = await h.service.createPage({
      slug: 'terms',
      title: 'Terms',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!page.ok || !other.ok) throw new Error('precondition');
    const version = await h.service.appendVersion({
      pageId: page.page.id,
      title: 'v1',
      body: '1',
      actorUserId: 'u',
      audit: actor(),
    });
    if (!version.ok) throw new Error('precondition');

    expect((await h.service.getVersion(page.page.id, version.version.id)).ok).toBe(true);
    expect(await h.service.getVersion(other.page.id, version.version.id)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
