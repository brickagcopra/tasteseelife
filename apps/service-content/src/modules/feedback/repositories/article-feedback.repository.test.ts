import { beforeEach, describe, expect, it } from 'vitest';

import { FakeFeedbackPrisma } from '../services/__fixtures__/fake-prisma';
import { ArticleFeedbackRepository } from './article-feedback.repository';

interface Harness {
  repo: ArticleFeedbackRepository;
  prisma: FakeFeedbackPrisma;
}

function build(): Harness {
  const prisma = new FakeFeedbackPrisma();
  const repo = new ArticleFeedbackRepository(prisma as never);
  return { repo, prisma };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('findArticle', () => {
  it('returns the bounded article row', async () => {
    h.prisma.seedArticle({ id: 'art_1', status: 'published', categoryId: 'cat_1' });
    expect(await h.repo.findArticle('art_1')).toMatchObject({
      id: 'art_1',
      status: 'published',
      categoryId: 'cat_1',
    });
  });

  it('returns null for a missing article', async () => {
    expect(await h.repo.findArticle('nope')).toBeNull();
  });
});

describe('upsertVote', () => {
  it('inserts a first vote', async () => {
    h.prisma.seedArticle({ id: 'art_1' });
    await h.repo.upsertVote('art_1', 'user_1', 'helpful');
    expect(await h.repo.findOwnRating('art_1', 'user_1')).toBe('helpful');
    expect(h.prisma.feedback).toHaveLength(1);
  });

  it('flips an existing vote in place (no duplicate row)', async () => {
    h.prisma.seedArticle({ id: 'art_1' });
    await h.repo.upsertVote('art_1', 'user_1', 'helpful');
    await h.repo.upsertVote('art_1', 'user_1', 'not_helpful');
    expect(await h.repo.findOwnRating('art_1', 'user_1')).toBe('not_helpful');
    expect(h.prisma.feedback).toHaveLength(1);
  });
});

describe('countByRating', () => {
  it('computes helpful / not-helpful counts on read', async () => {
    h.prisma.seedArticle({ id: 'art_1' });
    h.prisma.seedVote('art_1', 'u1', 'helpful');
    h.prisma.seedVote('art_1', 'u2', 'helpful');
    h.prisma.seedVote('art_1', 'u3', 'not_helpful');
    // a vote on another article must not leak in
    h.prisma.seedArticle({ id: 'art_2' });
    h.prisma.seedVote('art_2', 'u1', 'helpful');

    expect(await h.repo.countByRating('art_1')).toEqual({ helpfulCount: 2, notHelpfulCount: 1 });
  });

  it('returns zeroes for an article with no feedback', async () => {
    h.prisma.seedArticle({ id: 'art_1' });
    expect(await h.repo.countByRating('art_1')).toEqual({ helpfulCount: 0, notHelpfulCount: 0 });
  });
});

describe('findOwnRating', () => {
  it('returns null when the caller has not voted', async () => {
    h.prisma.seedArticle({ id: 'art_1' });
    expect(await h.repo.findOwnRating('art_1', 'user_1')).toBeNull();
  });
});

describe('findArticleAuthorIds', () => {
  it('returns the credited author ids', async () => {
    h.prisma.seedAuthorLink('art_1', 'au1');
    h.prisma.seedAuthorLink('art_1', 'au2');
    h.prisma.seedAuthorLink('art_2', 'au9');
    expect(await h.repo.findArticleAuthorIds('art_1')).toEqual(['au1', 'au2']);
  });
});

describe('findRelatedCandidates', () => {
  it('returns published articles (excluding self) hydrated with author ids', async () => {
    h.prisma.seedArticle({ id: 'target', status: 'published' });
    h.prisma.seedArticle({ id: 'pub_1', status: 'published', categoryId: 'cat_1' });
    h.prisma.seedArticle({ id: 'pub_2', status: 'published' });
    h.prisma.seedArticle({ id: 'draft_1', status: 'draft' });
    h.prisma.seedAuthorLink('pub_1', 'au1');

    const result = await h.repo.findRelatedCandidates('target');
    const ids = result.map((r) => r.id).sort();
    expect(ids).toEqual(['pub_1', 'pub_2']);
    expect(result.find((r) => r.id === 'pub_1')?.authorIds).toEqual(['au1']);
    expect(result.find((r) => r.id === 'pub_2')?.authorIds).toEqual([]);
  });

  it('excludes drafts and the target itself', async () => {
    h.prisma.seedArticle({ id: 'target', status: 'published' });
    h.prisma.seedArticle({ id: 'draft_1', status: 'draft' });
    const result = await h.repo.findRelatedCandidates('target');
    expect(result).toHaveLength(0);
  });
});
