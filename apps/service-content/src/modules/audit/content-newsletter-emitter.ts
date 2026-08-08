import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  CONTENT_NEWSLETTER_SEND_REQUESTED,
  type ContentNewsletterSendRequested,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

/**
 * What a newsletter send carries onto the bus — the marketing-email source facts
 * for a single published post. No subscriber PII (the per-recipient fan-out is
 * the consumer's job); `requestedByUserId` is the acting staff id, for the
 * consumer's send-provenance only.
 */
export interface NewsletterSendDescriptor {
  readonly articleId: string;
  readonly slug: string;
  readonly title: string;
  /** Bounded plain-text-ish lead derived from the published body (or null). */
  readonly excerpt: string | null;
  readonly seoTitle: string | null;
  readonly metaDescription: string | null;
  /** ISO-8601 with offset — when the current version became effective. */
  readonly publishedAt: string;
  readonly requestedByUserId: string;
}

/**
 * Raised when the outbox append rejects the `content.newsletter.send_requested`
 * payload (a producer-side validation failure). Thrown INSIDE the send
 * transaction so the whole send rolls back — a post marked "sent" that cannot
 * durably queue its delivery signal must not commit (the outbox invariant,
 * CLAUDE.md §5.3). In practice unreachable: the payload is built from typed
 * inputs validated against the same registry schema, so this guards a future
 * schema/skew drift rather than a runtime user path.
 */
export class NewsletterEmitFailedError extends Error {
  constructor(
    readonly articleId: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`content.newsletter.send_requested payload validation failed for article '${articleId}'`);
    this.name = 'NewsletterEmitFailedError';
  }
}

/**
 * Emits `content.newsletter.send_requested` to the transactional outbox (TS-288;
 * PDD §12.3; CLAUDE.md §5.3).
 *
 * Call `emit(tx, descriptor)` from INSIDE the send `$transaction` (the one that
 * stamps `newsletter_sent_at`) so the delivery signal commits atomically with
 * the send guard. The relay (`worker-outbox-relay`) already drains
 * `content.outbox_events` (TS-284) — a new event NAME on the same table needs no
 * relay-config change. The consumer (`service-notification`, TS-288-followup-1)
 * is idempotent on `eventId`, and the `newsletter_sent_at` guard is the second
 * line of defence against a re-send. Sibling to `ContentLegalEmitter` /
 * `ContentSearchEmitter` (the same in-tx append shape).
 */
@Injectable()
export class ContentNewsletterEmitter {
  private readonly logger = new Logger(ContentNewsletterEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emit(tx: OutboxRawExecutor, descriptor: NewsletterSendDescriptor): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: ContentNewsletterSendRequested = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      articleId: descriptor.articleId,
      slug: descriptor.slug,
      title: descriptor.title,
      excerpt: descriptor.excerpt,
      seoTitle: descriptor.seoTitle,
      metaDescription: descriptor.metaDescription,
      publishedAt: descriptor.publishedAt,
      requestedByUserId: descriptor.requestedByUserId,
    };

    const result = await this.outbox.append(tx, {
      eventName: CONTENT_NEWSLETTER_SEND_REQUESTED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new NewsletterEmitFailedError(descriptor.articleId, result.issues);
    }

    this.logger.log(
      { articleId: descriptor.articleId, slug: descriptor.slug, eventId },
      'content.newsletter.send_requested emitted',
    );
  }
}
