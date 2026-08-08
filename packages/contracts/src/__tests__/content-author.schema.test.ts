import { describe, expect, it } from 'vitest';

import {
  CONTENT_ARTICLE_AUTHORS_MAX,
  CONTENT_AUTHORS_LIST_LIMIT_DEFAULT,
  CONTENT_AUTHORS_LIST_LIMIT_MAX,
  CONTENT_AUTHOR_DISPLAY_NAME_MAX_LENGTH,
  ArticleAuthorSchema,
  ContentAuthorRecordSchema,
  CreateContentAuthorRequestSchema,
  ListContentAuthorsQuerySchema,
  SetArticleAuthorsRequestSchema,
  UpdateContentAuthorRequestSchema,
} from '../http/content-author.schema';

const ISO = '2026-06-30T00:00:00.000Z';

describe('CreateContentAuthorRequestSchema', () => {
  it('accepts userId + displayName, the rest optional', () => {
    const parsed = CreateContentAuthorRequestSchema.parse({ userId: 'usr_1', displayName: 'Ada' });
    expect(parsed.userId).toBe('usr_1');
    expect(parsed.bio).toBeUndefined();
  });

  it('accepts http/https social links', () => {
    const parsed = CreateContentAuthorRequestSchema.parse({
      userId: 'usr_1',
      displayName: 'Ada',
      socialLinks: { twitter: 'https://x.com/ada', website: 'http://ada.dev' },
    });
    expect(parsed.socialLinks?.twitter).toBe('https://x.com/ada');
  });

  it('rejects a javascript: social link', () => {
    expect(
      CreateContentAuthorRequestSchema.safeParse({
        userId: 'usr_1',
        displayName: 'Ada',
        // eslint-disable-next-line no-script-url
        socialLinks: { website: 'javascript:alert(1)' },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown social platform key', () => {
    expect(
      CreateContentAuthorRequestSchema.safeParse({
        userId: 'usr_1',
        displayName: 'Ada',
        socialLinks: { myspace: 'https://m.com' },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown top-level field (.strict)', () => {
    expect(
      CreateContentAuthorRequestSchema.safeParse({ userId: 'u', displayName: 'A', nope: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects a display name over the cap', () => {
    expect(
      CreateContentAuthorRequestSchema.safeParse({
        userId: 'u',
        displayName: 'x'.repeat(CONTENT_AUTHOR_DISPLAY_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe('UpdateContentAuthorRequestSchema', () => {
  it('accepts a single field + nullable clears', () => {
    expect(UpdateContentAuthorRequestSchema.parse({ displayName: 'New' }).displayName).toBe('New');
    expect(UpdateContentAuthorRequestSchema.parse({ bio: null }).bio).toBeNull();
  });

  it('rejects an empty patch', () => {
    expect(UpdateContentAuthorRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('SetArticleAuthorsRequestSchema', () => {
  it('accepts an ordered list; role defaults to co_author', () => {
    const parsed = SetArticleAuthorsRequestSchema.parse({
      authors: [{ authorId: 'a1', role: 'primary' }, { authorId: 'a2' }],
    });
    expect(parsed.authors[1]?.role).toBe('co_author');
  });

  it('accepts an empty set (clears the byline)', () => {
    expect(SetArticleAuthorsRequestSchema.parse({ authors: [] }).authors).toHaveLength(0);
  });

  it('rejects duplicate authorIds', () => {
    expect(
      SetArticleAuthorsRequestSchema.safeParse({
        authors: [{ authorId: 'a1' }, { authorId: 'a1' }],
      }).success,
    ).toBe(false);
  });

  it('rejects more than the max authors', () => {
    const authors = Array.from({ length: CONTENT_ARTICLE_AUTHORS_MAX + 1 }, (_, i) => ({
      authorId: `a${i}`,
    }));
    expect(SetArticleAuthorsRequestSchema.safeParse({ authors }).success).toBe(false);
  });
});

describe('records + list query', () => {
  it('parses a full author record', () => {
    const record = ContentAuthorRecordSchema.parse({
      id: 'author_1',
      userId: 'usr_1',
      displayName: 'Ada',
      bio: null,
      photoAssetKey: null,
      socialLinks: null,
      createdAt: ISO,
      updatedAt: ISO,
    });
    expect(record.id).toBe('author_1');
  });

  it('parses an article-author byline entry', () => {
    const entry = ArticleAuthorSchema.parse({
      role: 'primary',
      sortOrder: 0,
      author: {
        id: 'author_1',
        userId: 'usr_1',
        displayName: 'Ada',
        bio: null,
        photoAssetKey: null,
        socialLinks: null,
        createdAt: ISO,
        updatedAt: ISO,
      },
    });
    expect(entry.author.displayName).toBe('Ada');
  });

  it('defaults the list limit', () => {
    expect(ListContentAuthorsQuerySchema.parse({}).limit).toBe(CONTENT_AUTHORS_LIST_LIMIT_DEFAULT);
    expect(
      ListContentAuthorsQuerySchema.safeParse({ limit: CONTENT_AUTHORS_LIST_LIMIT_MAX + 1 })
        .success,
    ).toBe(false);
  });
});
