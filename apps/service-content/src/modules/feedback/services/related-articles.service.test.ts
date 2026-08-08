import { beforeEach, describe, expect, it } from 'vitest';

import { ArticleFeedbackRepository } from '../repositories/article-feedback.repository';
import { RelatedArticlesService } from './related-articles.service';
import { CategoryAuthorOverlapStrategy } from './related-articles.strategy';
import { FakeFeedbackPrisma } from './__fixtures__/fake-prisma';

interface Harness {
  service: RelatedArticlesService;
  prisma: FakeFeedbackPrisma;
}

function build(): Harness {
  const prisma = new FakeFeedbackPrisma();
  const repo = new ArticleFeedbackRepository(prisma as never);
  return { service: new RelatedArticlesService(repo, new CategoryAuthorOverlapStrategy()), prisma };
}

let h: Harness;
beforeEach(() => {
  h = build();
});

describe('getRelated', () => {
  it('ranks published articles sharing the target category / authors', async () => {
    h.prisma.seedArticle({ id: 'target', status: 'published', categoryId: 'cat_1' });
    h.prisma.seedAuthorLink('target', 'au1');

    h.prisma.seedArticle({ id: 'same_cat_and_author', status: 'published', categoryId: 'cat_1' });
    h.prisma.seedAuthorLink('same_cat_and_author', 'au1'); // score 3
    h.prisma.seedArticle({ id: 'same_cat', status: 'published', categoryId: 'cat_1' }); // score 2
    h.prisma.seedArticle({ id: 'unrelated', status: 'published', categoryId: 'cat_9' }); // score 0 → dropped

    const outcome = await h.service.getRelated('target', 5);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.related.map((r) => r.id)).toEqual(['same_cat_and_author', 'same_cat']);
    expect(outcome.related[0]?.score).toBe(3);
  });

  it('never includes the target itself', async () => {
    h.prisma.seedArticle({ id: 'target', status: 'published', categoryId: 'cat_1' });
    h.prisma.seedArticle({ id: 'other', status: 'published', categoryId: 'cat_1' });
    const outcome = await h.service.getRelated('target', 5);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.related.map((r) => r.id)).not.toContain('target');
  });

  it('honours the limit', async () => {
    h.prisma.seedArticle({ id: 'target', status: 'published', categoryId: 'cat_1' });
    for (const id of ['a', 'b', 'c']) {
      h.prisma.seedArticle({ id, status: 'published', categoryId: 'cat_1' });
    }
    const outcome = await h.service.getRelated('target', 2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.related).toHaveLength(2);
  });

  it('is not_available for a missing or unpublished target', async () => {
    expect(await h.service.getRelated('nope', 5)).toEqual({ ok: false, reason: 'not_available' });
    h.prisma.seedArticle({ id: 'draft', status: 'draft' });
    expect(await h.service.getRelated('draft', 5)).toEqual({ ok: false, reason: 'not_available' });
  });

  it('returns an empty list when nothing is related', async () => {
    h.prisma.seedArticle({ id: 'target', status: 'published', categoryId: 'cat_1' });
    h.prisma.seedArticle({ id: 'unrelated', status: 'published', categoryId: 'cat_9' });
    const outcome = await h.service.getRelated('target', 5);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.related).toEqual([]);
  });
});
