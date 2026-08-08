import { beforeEach, describe, expect, it } from 'vitest';

import { ArticleFeedbackRepository } from '../repositories/article-feedback.repository';
import { FeedbackService } from './feedback.service';
import { FakeFeedbackPrisma } from './__fixtures__/fake-prisma';

interface Harness {
  service: FeedbackService;
  prisma: FakeFeedbackPrisma;
}

function build(): Harness {
  const prisma = new FakeFeedbackPrisma();
  const repo = new ArticleFeedbackRepository(prisma as never);
  return { service: new FeedbackService(repo), prisma };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('submit', () => {
  it('records a vote on a published article and returns the aggregate + own rating', async () => {
    h.prisma.seedArticle({ id: 'art_1', status: 'published' });
    const outcome = await h.service.submit({ articleId: 'art_1', userId: 'u1', rating: 'helpful' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).toEqual({
      articleId: 'art_1',
      helpfulCount: 1,
      notHelpfulCount: 0,
      ownRating: 'helpful',
    });
  });

  it('flips a re-vote (upsert) rather than double-counting', async () => {
    h.prisma.seedArticle({ id: 'art_1', status: 'published' });
    await h.service.submit({ articleId: 'art_1', userId: 'u1', rating: 'helpful' });
    const outcome = await h.service.submit({
      articleId: 'art_1',
      userId: 'u1',
      rating: 'not_helpful',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).toEqual({
      articleId: 'art_1',
      helpfulCount: 0,
      notHelpfulCount: 1,
      ownRating: 'not_helpful',
    });
  });

  it('aggregates votes across users', async () => {
    h.prisma.seedArticle({ id: 'art_1', status: 'published' });
    await h.service.submit({ articleId: 'art_1', userId: 'u1', rating: 'helpful' });
    await h.service.submit({ articleId: 'art_1', userId: 'u2', rating: 'helpful' });
    const outcome = await h.service.submit({
      articleId: 'art_1',
      userId: 'u3',
      rating: 'not_helpful',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary.helpfulCount).toBe(2);
    expect(outcome.summary.notHelpfulCount).toBe(1);
    expect(outcome.summary.ownRating).toBe('not_helpful');
  });

  it.each(['draft', 'archived'] as const)(
    'rejects feedback on a %s article as not_available',
    async (status) => {
      h.prisma.seedArticle({ id: 'art_1', status });
      const outcome = await h.service.submit({
        articleId: 'art_1',
        userId: 'u1',
        rating: 'helpful',
      });
      expect(outcome).toEqual({ ok: false, reason: 'not_available' });
      expect(h.prisma.feedback).toHaveLength(0);
    },
  );

  it('rejects feedback on a missing article as not_available (no draft-existence leak)', async () => {
    const outcome = await h.service.submit({ articleId: 'nope', userId: 'u1', rating: 'helpful' });
    expect(outcome).toEqual({ ok: false, reason: 'not_available' });
  });
});

describe('getSummary', () => {
  it('reports the aggregate + the caller own rating (null when not voted)', async () => {
    h.prisma.seedArticle({ id: 'art_1', status: 'published' });
    h.prisma.seedVote('art_1', 'other', 'helpful');
    const outcome = await h.service.getSummary('art_1', 'me');

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.summary).toEqual({
      articleId: 'art_1',
      helpfulCount: 1,
      notHelpfulCount: 0,
      ownRating: null,
    });
  });

  it('is not_available for an unpublished article', async () => {
    h.prisma.seedArticle({ id: 'art_1', status: 'draft' });
    expect(await h.service.getSummary('art_1', 'me')).toEqual({
      ok: false,
      reason: 'not_available',
    });
  });
});
