import { describe, expect, it } from 'vitest';

import {
  CATEGORY_MATCH_WEIGHT,
  CategoryAuthorOverlapStrategy,
  SHARED_AUTHOR_WEIGHT,
  type RelatedCandidate,
  type RelatedTarget,
} from './related-articles.strategy';

const strategy = new CategoryAuthorOverlapStrategy();

function candidate(over: Partial<RelatedCandidate> & { id: string }): RelatedCandidate {
  return {
    id: over.id,
    slug: over.slug ?? `${over.id}-slug`,
    title: over.title ?? `${over.id} title`,
    categoryId: over.categoryId ?? null,
    authorIds: over.authorIds ?? [],
  };
}

describe('CategoryAuthorOverlapStrategy', () => {
  it('scores a shared category by CATEGORY_MATCH_WEIGHT', () => {
    const target: RelatedTarget = { id: 'a', categoryId: 'cat_1', authorIds: [] };
    const result = strategy.rank(target, [candidate({ id: 'b', categoryId: 'cat_1' })], 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.score).toBe(CATEGORY_MATCH_WEIGHT);
  });

  it('scores each shared author by SHARED_AUTHOR_WEIGHT', () => {
    const target: RelatedTarget = { id: 'a', categoryId: null, authorIds: ['au1', 'au2'] };
    const result = strategy.rank(
      target,
      [candidate({ id: 'b', authorIds: ['au1', 'au2', 'au3'] })],
      5,
    );
    expect(result[0]?.score).toBe(SHARED_AUTHOR_WEIGHT * 2);
  });

  it('sums category + author overlap', () => {
    const target: RelatedTarget = { id: 'a', categoryId: 'cat_1', authorIds: ['au1'] };
    const result = strategy.rank(
      target,
      [candidate({ id: 'b', categoryId: 'cat_1', authorIds: ['au1'] })],
      5,
    );
    expect(result[0]?.score).toBe(CATEGORY_MATCH_WEIGHT + SHARED_AUTHOR_WEIGHT);
  });

  it('drops candidates that share nothing (score 0)', () => {
    const target: RelatedTarget = { id: 'a', categoryId: 'cat_1', authorIds: ['au1'] };
    const result = strategy.rank(
      target,
      [candidate({ id: 'b', categoryId: 'cat_2', authorIds: ['au9'] })],
      5,
    );
    expect(result).toHaveLength(0);
  });

  it('does not match on a null target category (null !== null for scoring)', () => {
    const target: RelatedTarget = { id: 'a', categoryId: null, authorIds: [] };
    const result = strategy.rank(target, [candidate({ id: 'b', categoryId: null })], 5);
    expect(result).toHaveLength(0);
  });

  it('excludes the target itself even if present in candidates', () => {
    const target: RelatedTarget = { id: 'a', categoryId: 'cat_1', authorIds: [] };
    const result = strategy.rank(
      target,
      [candidate({ id: 'a', categoryId: 'cat_1' }), candidate({ id: 'b', categoryId: 'cat_1' })],
      5,
    );
    expect(result.map((r) => r.id)).toEqual(['b']);
  });

  it('sorts by score desc, then id asc for determinism', () => {
    const target: RelatedTarget = { id: 'a', categoryId: 'cat_1', authorIds: ['au1'] };
    const result = strategy.rank(
      target,
      [
        candidate({ id: 'zzz', categoryId: 'cat_1' }), // score 2
        candidate({ id: 'bbb', categoryId: 'cat_1', authorIds: ['au1'] }), // score 3
        candidate({ id: 'aaa', categoryId: 'cat_1' }), // score 2
      ],
      5,
    );
    expect(result.map((r) => r.id)).toEqual(['bbb', 'aaa', 'zzz']);
  });

  it('honours the limit', () => {
    const target: RelatedTarget = { id: 'a', categoryId: 'cat_1', authorIds: [] };
    const cands = ['b', 'c', 'd', 'e'].map((id) => candidate({ id, categoryId: 'cat_1' }));
    expect(strategy.rank(target, cands, 2)).toHaveLength(2);
  });

  it('exposes a stable name for observability', () => {
    expect(strategy.name).toBe('category-author-overlap-v1');
  });
});
