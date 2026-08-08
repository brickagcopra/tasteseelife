import { describe, expect, it } from 'vitest';

import {
  CONTENT_NEWSLETTER_EVENT_EXCERPT_MAX_LENGTH,
  CONTENT_NEWSLETTER_SEND_REQUESTED,
  ContentNewsletterSendRequestedSchema,
  eventRegistry,
  getEventSchema,
} from '../events';

/**
 * Contract tests for the content newsletter event (TS-288).
 *
 * Pins the wire shape (`.strict()`), the envelope, the bounded fields, and the
 * registry wiring — so a producer edit is a parse error and the (carved)
 * `service-notification` consumer (TS-288-followup-1) can map the payload 1:1.
 */
describe('content newsletter event registry wiring', () => {
  it('registers the event under its dotted constant', () => {
    expect(eventRegistry[CONTENT_NEWSLETTER_SEND_REQUESTED]).toBe(
      ContentNewsletterSendRequestedSchema,
    );
    expect(getEventSchema(CONTENT_NEWSLETTER_SEND_REQUESTED)).toBe(
      ContentNewsletterSendRequestedSchema,
    );
  });

  it('uses a past-tense dotted name', () => {
    expect(CONTENT_NEWSLETTER_SEND_REQUESTED).toBe('content.newsletter.send_requested');
    expect(CONTENT_NEWSLETTER_SEND_REQUESTED).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });
});

describe('ContentNewsletterSendRequested event', () => {
  const valid = {
    eventId: 'evt_1',
    occurredAt: '2026-06-30T12:00:00.000Z',
    articleId: 'art_1',
    slug: 'welcome-to-taste-and-see',
    title: 'Welcome to Taste & See',
    excerpt: 'A short lead paragraph.',
    seoTitle: 'Welcome | Taste & See',
    metaDescription: 'Get started with Taste & See.',
    publishedAt: '2026-07-01T00:00:00.000Z',
    requestedByUserId: 'user_admin',
  };

  it('accepts a valid payload', () => {
    expect(ContentNewsletterSendRequestedSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts nullable lead/SEO fields as null', () => {
    const parsed = ContentNewsletterSendRequestedSchema.safeParse({
      ...valid,
      excerpt: null,
      seoTitle: null,
      metaDescription: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown field (.strict)', () => {
    expect(
      ContentNewsletterSendRequestedSchema.safeParse({ ...valid, recipientEmail: 'x@y.z' }).success,
    ).toBe(false);
  });

  it('requires the requesting staff id', () => {
    const { requestedByUserId: _omit, ...withoutActor } = valid;
    expect(ContentNewsletterSendRequestedSchema.safeParse(withoutActor).success).toBe(false);
  });

  it('rejects an over-long excerpt', () => {
    const parsed = ContentNewsletterSendRequestedSchema.safeParse({
      ...valid,
      excerpt: 'x'.repeat(CONTENT_NEWSLETTER_EVENT_EXCERPT_MAX_LENGTH + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it('requires an offset timestamp for publishedAt', () => {
    expect(
      ContentNewsletterSendRequestedSchema.safeParse({ ...valid, publishedAt: 'not-a-date' })
        .success,
    ).toBe(false);
  });
});
