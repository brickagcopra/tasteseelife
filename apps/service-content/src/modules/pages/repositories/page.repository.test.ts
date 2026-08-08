import { describe, expect, it, vi, beforeEach } from 'vitest';

import { FakeContentPrisma } from '../services/__fixtures__/fake-prisma';
import { PageRepository } from './page.repository';

let prisma: FakeContentPrisma;
let repo: PageRepository;

beforeEach(() => {
  prisma = new FakeContentPrisma();
  repo = new PageRepository(prisma as never);
});

describe('createPage', () => {
  it('inserts a draft page and runs onPersist inside the transaction', async () => {
    const onPersist = vi.fn(async () => undefined);
    const page = await repo.createPage({ slug: 'privacy', title: 'Privacy' }, onPersist);

    expect(page.slug).toBe('privacy');
    expect(page.status).toBe('draft');
    expect(page.currentVersionId).toBeNull();
    // onPersist receives the tx client (the fake itself) + the created row.
    expect(onPersist).toHaveBeenCalledWith(prisma, page);
  });

  it('finds a page by slug and by id', async () => {
    const page = await repo.createPage({ slug: 'about', title: 'About' });
    expect((await repo.findPageBySlug('about'))?.id).toBe(page.id);
    expect((await repo.findPage(page.id))?.slug).toBe('about');
    expect(await repo.findPageBySlug('missing')).toBeNull();
  });
});

describe('listPages', () => {
  it('returns newest-first, honours the limit, and filters by status', async () => {
    await repo.createPage({ slug: 'a', title: 'A' });
    const b = await repo.createPage({ slug: 'b', title: 'B' });
    await repo.createPage({ slug: 'c', title: 'C' });

    const all = await repo.listPages({ limit: 50 });
    expect(all.map((p) => p.slug)).toEqual(['c', 'b', 'a']);

    const limited = await repo.listPages({ limit: 2 });
    expect(limited).toHaveLength(2);

    // Flip b to published and filter.
    const row = prisma.pages.find((p) => p['id'] === b.id);
    if (row !== undefined) row['status'] = 'published';
    const published = await repo.listPages({ status: 'published', limit: 50 });
    expect(published.map((p) => p.slug)).toEqual(['b']);
  });
});

describe('appendVersion', () => {
  it('assigns monotonic per-page version numbers', async () => {
    const page = await repo.createPage({ slug: 'terms', title: 'Terms' });
    const v1 = await repo.appendVersion(page.id, { title: 'v1', body: '1', createdBy: 'u' });
    const v2 = await repo.appendVersion(page.id, { title: 'v2', body: '2', createdBy: 'u' });

    expect(v1.versionNo).toBe(1);
    expect(v2.versionNo).toBe(2);
    expect(v1.effectiveAt).toBeNull();
  });

  it('numbers versions independently across pages', async () => {
    const a = await repo.createPage({ slug: 'a', title: 'A' });
    const b = await repo.createPage({ slug: 'b', title: 'B' });
    await repo.appendVersion(a.id, { title: 'a1', body: 'x', createdBy: 'u' });
    const b1 = await repo.appendVersion(b.id, { title: 'b1', body: 'y', createdBy: 'u' });
    expect(b1.versionNo).toBe(1);
  });

  it('findDetail returns versions newest-first', async () => {
    const page = await repo.createPage({ slug: 'about', title: 'About' });
    await repo.appendVersion(page.id, { title: 'v1', body: '1', createdBy: 'u' });
    await repo.appendVersion(page.id, { title: 'v2', body: '2', createdBy: 'u' });

    const detail = await repo.findDetail(page.id);
    expect(detail?.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    expect(await repo.findDetail('missing')).toBeNull();
  });

  it('findVersion scopes by page', async () => {
    const a = await repo.createPage({ slug: 'a', title: 'A' });
    const b = await repo.createPage({ slug: 'b', title: 'B' });
    const v = await repo.appendVersion(a.id, { title: 'v1', body: '1', createdBy: 'u' });
    expect((await repo.findVersion(a.id, v.id))?.id).toBe(v.id);
    expect(await repo.findVersion(b.id, v.id)).toBeNull();
  });
});

describe('publishVersion', () => {
  it('stamps effectiveAt, repoints currentVersionId, moves the page to published, and audits in-tx', async () => {
    const page = await repo.createPage({ slug: 'cookie', title: 'Cookie' });
    const version = await repo.appendVersion(page.id, { title: 'v1', body: '1', createdBy: 'u' });
    const effectiveAt = new Date(Date.UTC(2026, 6, 1));
    const onPersist = vi.fn(async () => undefined);

    const result = await repo.publishVersion(
      page.id,
      version.id,
      { effectiveAt, isMaterialChange: false, materialChangeNote: null },
      onPersist,
    );

    expect(result.page.status).toBe('published');
    expect(result.page.currentVersionId).toBe(version.id);
    expect(result.version.effectiveAt?.toISOString()).toBe(effectiveAt.toISOString());
    expect(result.version.isMaterialChange).toBe(false);
    expect(onPersist).toHaveBeenCalledWith(prisma, result);
  });

  it('persists the material-change flag + note on a material publish (TS-285)', async () => {
    const page = await repo.createPage({ slug: 'terms', title: 'Terms' });
    const version = await repo.appendVersion(page.id, { title: 'v1', body: '1', createdBy: 'u' });
    const effectiveAt = new Date(Date.UTC(2026, 6, 1));

    const result = await repo.publishVersion(page.id, version.id, {
      effectiveAt,
      isMaterialChange: true,
      materialChangeNote: 'New arbitration clause.',
    });

    expect(result.version.isMaterialChange).toBe(true);
    expect(result.version.materialChangeNote).toBe('New arbitration clause.');
  });
});
