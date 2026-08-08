import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AuditActorContext } from '@taste-and-see/nest-audit';
import type { AuditEmitter } from '@taste-and-see/nest-audit';
import { AuthorRepository } from '../repositories/author.repository';
import { AuthorsService } from './authors.service';
import { FakeAuthorPrisma } from './__fixtures__/fake-prisma';

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
  service: AuthorsService;
  prisma: FakeAuthorPrisma;
  emit: ReturnType<typeof vi.fn>;
}

function build(): Harness {
  const prisma = new FakeAuthorPrisma();
  const repo = new AuthorRepository(prisma as never);
  const emit = vi.fn().mockResolvedValue(undefined);
  const audit = { emit } as unknown as AuditEmitter;
  const service = new AuthorsService(repo, audit);
  return { service, prisma, emit };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

async function seedAuthor(userId: string, displayName: string): Promise<string> {
  const outcome = await h.service.createAuthor({
    userId,
    displayName,
    actorUserId: 'u',
    audit: actor(),
  });
  if (!outcome.ok) throw new Error('seed failed');
  return outcome.author.id;
}

describe('createAuthor', () => {
  it('creates an author profile and emits content_author:create in-tx', async () => {
    const outcome = await h.service.createAuthor({
      userId: 'user_writer',
      displayName: 'Ada Writer',
      bio: 'Loves food',
      actorUserId: 'user_admin',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.author.userId).toBe('user_writer');
    expect(outcome.author.displayName).toBe('Ada Writer');
    expect(outcome.author.bio).toBe('Loves food');
    expect(outcome.author.photoAssetKey).toBeNull();
    expect(outcome.author.socialLinks).toBeNull();
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({
      action: 'content_author:create',
      resourceKind: 'content_author',
    });
    expect(h.emit.mock.calls[0]?.[0]).toBe(h.prisma);
  });

  it('stores social links when supplied', async () => {
    const outcome = await h.service.createAuthor({
      userId: 'u1',
      displayName: 'Soc',
      socialLinks: { twitter: 'https://x.com/soc' },
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.author.socialLinks).toEqual({ twitter: 'https://x.com/soc' });
  });

  it('rejects a duplicate userId with user_conflict (no emit)', async () => {
    await seedAuthor('dup', 'First');
    h.emit.mockClear();
    const outcome = await h.service.createAuthor({
      userId: 'dup',
      displayName: 'Second',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'user_conflict' });
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('updateAuthor', () => {
  it('updates fields and emits content_author:update with before/after', async () => {
    const id = await seedAuthor('u1', 'Old Name');
    h.emit.mockClear();

    const outcome = await h.service.updateAuthor({
      authorId: id,
      displayName: 'New Name',
      bio: 'Updated bio',
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok && outcome.author.displayName).toBe('New Name');
    expect(outcome.ok && outcome.author.bio).toBe('Updated bio');
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({ action: 'content_author:update' });
    const desc = h.emit.mock.calls[0]?.[2] as {
      before: { displayName: string };
      after: { displayName: string };
    };
    expect(desc.before.displayName).toBe('Old Name');
    expect(desc.after.displayName).toBe('New Name');
  });

  it('clears social links via the raw NULL path when passed null', async () => {
    const create = await h.service.createAuthor({
      userId: 'u1',
      displayName: 'S',
      socialLinks: { website: 'https://s.dev' },
      actorUserId: 'u',
      audit: actor(),
    });
    if (!create.ok) throw new Error('seed');
    const outcome = await h.service.updateAuthor({
      authorId: create.author.id,
      socialLinks: null,
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.author.socialLinks).toBeNull();
  });

  it('404s an unknown author (no emit)', async () => {
    const outcome = await h.service.updateAuthor({
      authorId: 'nope',
      displayName: 'x',
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'author_not_found' });
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('listAuthors / getAuthor', () => {
  it('lists authors ordered by display name', async () => {
    await seedAuthor('u1', 'Zoe');
    await seedAuthor('u2', 'Alice');
    const list = await h.service.listAuthors(50);
    expect(list.map((a) => a.displayName)).toEqual(['Alice', 'Zoe']);
  });

  it('returns a single author, 404 on miss', async () => {
    const id = await seedAuthor('u1', 'Solo');
    const hit = await h.service.getAuthor(id);
    expect(hit.ok && hit.author.userId).toBe('u1');
    const miss = await h.service.getAuthor('nope');
    expect(miss).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('setArticleAuthors', () => {
  beforeEach(() => {
    h.prisma.seedArticle('art_1');
  });

  it('replaces the byline with the ordered set + emits authors_set in-tx', async () => {
    const a1 = await seedAuthor('u1', 'A1');
    const a2 = await seedAuthor('u2', 'A2');
    h.emit.mockClear();

    const outcome = await h.service.setArticleAuthors({
      articleId: 'art_1',
      authors: [
        { authorId: a1, role: 'primary' },
        { authorId: a2, role: 'co_author' },
      ],
      actorUserId: 'u',
      audit: actor(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.authors.map((x) => x.author.id)).toEqual([a1, a2]);
    expect(outcome.authors.map((x) => x.sortOrder)).toEqual([0, 1]);
    expect(outcome.authors[0]?.role).toBe('primary');
    expect(h.emit.mock.calls[0]?.[2]).toMatchObject({
      action: 'content_article:authors_set',
      resourceKind: 'content_article',
    });
  });

  it('is a full replace (previous authors dropped)', async () => {
    const a1 = await seedAuthor('u1', 'A1');
    const a2 = await seedAuthor('u2', 'A2');
    await h.service.setArticleAuthors({
      articleId: 'art_1',
      authors: [{ authorId: a1, role: 'primary' }],
      actorUserId: 'u',
      audit: actor(),
    });
    const outcome = await h.service.setArticleAuthors({
      articleId: 'art_1',
      authors: [{ authorId: a2, role: 'primary' }],
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.authors.map((x) => x.author.id)).toEqual([a2]);
  });

  it('clears the byline on an empty set', async () => {
    const a1 = await seedAuthor('u1', 'A1');
    await h.service.setArticleAuthors({
      articleId: 'art_1',
      authors: [{ authorId: a1, role: 'primary' }],
      actorUserId: 'u',
      audit: actor(),
    });
    const outcome = await h.service.setArticleAuthors({
      articleId: 'art_1',
      authors: [],
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome.ok && outcome.authors).toEqual([]);
  });

  it('404s an unknown article (no emit)', async () => {
    const a1 = await seedAuthor('u1', 'A1');
    h.emit.mockClear();
    const outcome = await h.service.setArticleAuthors({
      articleId: 'ghost',
      authors: [{ authorId: a1, role: 'primary' }],
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'article_not_found' });
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('404s when an author id does not resolve (no emit)', async () => {
    h.emit.mockClear();
    const outcome = await h.service.setArticleAuthors({
      articleId: 'art_1',
      authors: [{ authorId: 'ghost', role: 'primary' }],
      actorUserId: 'u',
      audit: actor(),
    });
    expect(outcome).toEqual({ ok: false, reason: 'author_not_found' });
    expect(h.emit).not.toHaveBeenCalled();
  });
});

describe('getArticleAuthors', () => {
  it('returns the ordered byline, 404 on unknown article', async () => {
    h.prisma.seedArticle('art_1');
    const a1 = await seedAuthor('u1', 'A1');
    await h.service.setArticleAuthors({
      articleId: 'art_1',
      authors: [{ authorId: a1, role: 'primary' }],
      actorUserId: 'u',
      audit: actor(),
    });
    const hit = await h.service.getArticleAuthors('art_1');
    expect(hit.ok && hit.authors.map((x) => x.author.id)).toEqual([a1]);
    const miss = await h.service.getArticleAuthors('ghost');
    expect(miss).toEqual({ ok: false, reason: 'article_not_found' });
  });
});
