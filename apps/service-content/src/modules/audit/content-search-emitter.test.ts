import {
  CONTENT_ARTICLE_PUBLISHED,
  CONTENT_ARTICLE_UNPUBLISHED,
  CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH,
  ContentArticlePublishedSchema,
  ContentArticleUnpublishedSchema,
} from '@taste-and-see/contracts';
import { OutboxService, type AppendResult } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import {
  ContentSearchEmitFailedError,
  ContentSearchEmitter,
  deriveExcerpt,
  type ArticlePublishedDescriptor,
} from './content-search-emitter';

const TX = {} as never;

function descriptor(
  overrides: Partial<ArticlePublishedDescriptor> = {},
): ArticlePublishedDescriptor {
  return {
    articleId: 'art_1',
    slug: 'welcome',
    title: 'Welcome',
    body: '# Welcome\n\nBody text.',
    categoryId: 'cat_1',
    authorIds: ['author_1', 'author_2'],
    seoTitle: 'Welcome | Taste & See',
    metaDescription: 'Intro.',
    publishedAt: '2026-07-01T00:00:00.000Z',
    versionNo: 2,
    ...overrides,
  };
}

function build(result: AppendResult): {
  emitter: ContentSearchEmitter;
  append: ReturnType<typeof vi.fn>;
} {
  const append = vi.fn(async (): Promise<AppendResult> => result);
  const outbox = { append } as unknown as OutboxService;
  return { emitter: new ContentSearchEmitter(outbox), append };
}

describe('deriveExcerpt', () => {
  it('collapses whitespace and returns the lead', () => {
    expect(deriveExcerpt('# Title\n\n  Some   body ')).toBe('# Title Some body');
  });

  it('returns null for an empty / whitespace-only body', () => {
    expect(deriveExcerpt('')).toBeNull();
    expect(deriveExcerpt('   \n\t ')).toBeNull();
  });

  it('truncates at the cap', () => {
    const excerpt = deriveExcerpt('x'.repeat(CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH + 50));
    expect(excerpt).toHaveLength(CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH);
  });
});

describe('ContentSearchEmitter.emitPublished', () => {
  const appended: AppendResult = {
    kind: 'appended',
    eventId: 'ignored',
    eventName: CONTENT_ARTICLE_PUBLISHED,
    occurredAt: new Date(),
  };

  it('appends content.article.published mapping the descriptor to a valid payload', async () => {
    const { emitter, append } = build(appended);
    await emitter.emitPublished(TX, descriptor());

    expect(append).toHaveBeenCalledTimes(1);
    const [, args] = append.mock.calls[0]!;
    expect(args.eventName).toBe(CONTENT_ARTICLE_PUBLISHED);
    expect(args.payload).toMatchObject({
      articleId: 'art_1',
      slug: 'welcome',
      title: 'Welcome',
      body: '# Welcome\n\nBody text.',
      excerpt: '# Welcome Body text.',
      categoryId: 'cat_1',
      authorIds: ['author_1', 'author_2'],
      seoTitle: 'Welcome | Taste & See',
      metaDescription: 'Intro.',
      versionNo: 2,
    });
    expect(ContentArticlePublishedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('stamps the SAME eventId + occurredAt on the row args and the payload envelope', async () => {
    const { emitter, append } = build(appended);
    await emitter.emitPublished(TX, descriptor());
    const [, args] = append.mock.calls[0]!;
    expect(args.eventId).toBe(args.payload.eventId);
    expect((args.occurredAt as Date).toISOString()).toBe(args.payload.occurredAt);
  });

  it('carries nullable fields + an empty byline through', async () => {
    const { emitter, append } = build(appended);
    await emitter.emitPublished(
      TX,
      descriptor({
        body: '',
        categoryId: null,
        authorIds: [],
        seoTitle: null,
        metaDescription: null,
      }),
    );
    const [, args] = append.mock.calls[0]!;
    expect(args.payload).toMatchObject({
      excerpt: null,
      body: '',
      categoryId: null,
      authorIds: [],
      seoTitle: null,
      metaDescription: null,
    });
    expect(ContentArticlePublishedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('throws ContentSearchEmitFailedError when the outbox rejects the payload', async () => {
    const { emitter } = build({
      kind: 'validation_failed',
      eventName: CONTENT_ARTICLE_PUBLISHED,
      issues: [{ path: ['slug'], message: 'bad' }],
    });
    await expect(emitter.emitPublished(TX, descriptor())).rejects.toBeInstanceOf(
      ContentSearchEmitFailedError,
    );
  });
});

describe('ContentSearchEmitter.emitUnpublished', () => {
  const appended: AppendResult = {
    kind: 'appended',
    eventId: 'ignored',
    eventName: CONTENT_ARTICLE_UNPUBLISHED,
    occurredAt: new Date(),
  };

  it('appends a valid content.article.unpublished tombstone', async () => {
    const { emitter, append } = build(appended);
    await emitter.emitUnpublished(TX, { articleId: 'art_1', slug: 'welcome' });
    const [, args] = append.mock.calls[0]!;
    expect(args.eventName).toBe(CONTENT_ARTICLE_UNPUBLISHED);
    expect(args.payload).toMatchObject({ articleId: 'art_1', slug: 'welcome' });
    expect(ContentArticleUnpublishedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('throws when the outbox rejects the tombstone', async () => {
    const { emitter } = build({
      kind: 'validation_failed',
      eventName: CONTENT_ARTICLE_UNPUBLISHED,
      issues: [{ path: ['articleId'], message: 'bad' }],
    });
    await expect(
      emitter.emitUnpublished(TX, { articleId: 'art_1', slug: 'welcome' }),
    ).rejects.toBeInstanceOf(ContentSearchEmitFailedError);
  });
});
