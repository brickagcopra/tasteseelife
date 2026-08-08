import {
  CONTENT_NEWSLETTER_SEND_REQUESTED,
  ContentNewsletterSendRequestedSchema,
} from '@taste-and-see/contracts';
import { OutboxService, type AppendResult } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import {
  ContentNewsletterEmitter,
  NewsletterEmitFailedError,
  type NewsletterSendDescriptor,
} from './content-newsletter-emitter';

const TX = {} as never;

function descriptor(overrides: Partial<NewsletterSendDescriptor> = {}): NewsletterSendDescriptor {
  return {
    articleId: 'art_1',
    slug: 'welcome-to-taste-and-see',
    title: 'Welcome to Taste & See',
    excerpt: 'A short lead paragraph.',
    seoTitle: 'Welcome | Taste & See',
    metaDescription: 'Get started.',
    publishedAt: '2026-07-01T00:00:00.000Z',
    requestedByUserId: 'user_admin',
    ...overrides,
  };
}

function build(result: AppendResult): {
  emitter: ContentNewsletterEmitter;
  append: ReturnType<typeof vi.fn>;
} {
  const append = vi.fn(async (): Promise<AppendResult> => result);
  const outbox = { append } as unknown as OutboxService;
  return { emitter: new ContentNewsletterEmitter(outbox), append };
}

describe('ContentNewsletterEmitter.emit', () => {
  const appended: AppendResult = {
    kind: 'appended',
    eventId: 'ignored',
    eventName: CONTENT_NEWSLETTER_SEND_REQUESTED,
    occurredAt: new Date(),
  };

  it('appends content.newsletter.send_requested mapping the descriptor to a valid payload', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, descriptor());

    expect(append).toHaveBeenCalledTimes(1);
    const [, args] = append.mock.calls[0]!;
    expect(args.eventName).toBe(CONTENT_NEWSLETTER_SEND_REQUESTED);
    expect(args.payload).toMatchObject({
      articleId: 'art_1',
      slug: 'welcome-to-taste-and-see',
      title: 'Welcome to Taste & See',
      requestedByUserId: 'user_admin',
    });
    expect(ContentNewsletterSendRequestedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('stamps the SAME eventId + occurredAt on the row args and the payload envelope', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, descriptor());
    const [, args] = append.mock.calls[0]!;
    expect(args.eventId).toBe(args.payload.eventId);
    expect((args.occurredAt as Date).toISOString()).toBe(args.payload.occurredAt);
  });

  it('carries null lead/SEO fields through to the payload', async () => {
    const { emitter, append } = build(appended);
    await emitter.emit(TX, descriptor({ excerpt: null, seoTitle: null, metaDescription: null }));
    const [, args] = append.mock.calls[0]!;
    expect(args.payload.excerpt).toBeNull();
    expect(args.payload.seoTitle).toBeNull();
    expect(ContentNewsletterSendRequestedSchema.safeParse(args.payload).success).toBe(true);
  });

  it('throws NewsletterEmitFailedError when the outbox rejects the payload', async () => {
    const { emitter } = build({
      kind: 'validation_failed',
      eventName: CONTENT_NEWSLETTER_SEND_REQUESTED,
      issues: [{ path: ['slug'], message: 'bad' }],
    });
    await expect(emitter.emit(TX, descriptor())).rejects.toBeInstanceOf(NewsletterEmitFailedError);
  });
});
