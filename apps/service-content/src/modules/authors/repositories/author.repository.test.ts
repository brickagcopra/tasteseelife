import { describe, expect, it, beforeEach } from 'vitest';

import { FakeAuthorPrisma } from '../services/__fixtures__/fake-prisma';
import { AuthorRepository } from './author.repository';

interface Harness {
  repo: AuthorRepository;
  prisma: FakeAuthorPrisma;
}

function build(): Harness {
  const prisma = new FakeAuthorPrisma();
  const repo = new AuthorRepository(prisma as never);
  return { repo, prisma };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('createAuthor / findAuthorByUserId', () => {
  it('persists an author and finds it by userId', async () => {
    const created = await h.repo.createAuthor({
      userId: 'u1',
      displayName: 'A',
      bio: null,
      photoAssetKey: null,
      socialLinks: null,
    });
    const found = await h.repo.findAuthorByUserId('u1');
    expect(found?.id).toBe(created.id);
    expect(await h.repo.findAuthorByUserId('nope')).toBeNull();
  });
});

describe('updateAuthor socialLinks clear', () => {
  it('clears social_links via the raw NULL path', async () => {
    const created = await h.repo.createAuthor({
      userId: 'u1',
      displayName: 'A',
      bio: null,
      photoAssetKey: null,
      socialLinks: { website: 'https://a.dev' },
    });
    const updated = await h.repo.updateAuthor(created.id, { socialLinks: null });
    expect(updated.socialLinks).toBeNull();
  });

  it('writes a social_links value through the ORM', async () => {
    const created = await h.repo.createAuthor({
      userId: 'u1',
      displayName: 'A',
      bio: null,
      photoAssetKey: null,
      socialLinks: null,
    });
    const updated = await h.repo.updateAuthor(created.id, {
      socialLinks: { twitter: 'https://x/a' },
    });
    expect(updated.socialLinks).toEqual({ twitter: 'https://x/a' });
  });
});

describe('allAuthorsExist', () => {
  it('is true only when every id resolves (dedupes)', async () => {
    const a1 = await h.repo.createAuthor({
      userId: 'u1',
      displayName: 'A',
      bio: null,
      photoAssetKey: null,
      socialLinks: null,
    });
    expect(await h.repo.allAuthorsExist([])).toBe(true);
    expect(await h.repo.allAuthorsExist([a1.id, a1.id])).toBe(true);
    expect(await h.repo.allAuthorsExist([a1.id, 'ghost'])).toBe(false);
  });
});

describe('setArticleAuthors / listArticleAuthors', () => {
  it('replaces the byline and reads it back ordered by sortOrder', async () => {
    h.prisma.seedArticle('art_1');
    const a1 = await h.repo.createAuthor({
      userId: 'u1',
      displayName: 'A1',
      bio: null,
      photoAssetKey: null,
      socialLinks: null,
    });
    const a2 = await h.repo.createAuthor({
      userId: 'u2',
      displayName: 'A2',
      bio: null,
      photoAssetKey: null,
      socialLinks: null,
    });

    await h.repo.setArticleAuthors('art_1', [
      { authorId: a2.id, role: 'primary', sortOrder: 0 },
      { authorId: a1.id, role: 'co_author', sortOrder: 1 },
    ]);
    const byline = await h.repo.listArticleAuthors('art_1');
    expect(byline.map((b) => b.author.id)).toEqual([a2.id, a1.id]);
    expect(byline.map((b) => b.role)).toEqual(['primary', 'co_author']);

    // A second set fully replaces the first.
    await h.repo.setArticleAuthors('art_1', [{ authorId: a1.id, role: 'primary', sortOrder: 0 }]);
    const replaced = await h.repo.listArticleAuthors('art_1');
    expect(replaced.map((b) => b.author.id)).toEqual([a1.id]);
  });
});
