import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  CONTENT_ARTICLE_PUBLISHED,
  CONTENT_ARTICLE_UNPUBLISHED,
  CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH,
  type ContentArticlePublished,
  type ContentArticleUnpublished,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

/**
 * The indexable projection a published article carries onto the bus — the full
 * ES-document source. No PII (editorial content; author/category *ids* only).
 */
export interface ArticlePublishedDescriptor {
  readonly articleId: string;
  readonly slug: string;
  readonly title: string;
  /** Full published Markdown body. */
  readonly body: string;
  readonly categoryId: string | null;
  /** Ordered byline author ids (soft ids into `content.content_authors`). */
  readonly authorIds: readonly string[];
  readonly seoTitle: string | null;
  readonly metaDescription: string | null;
  /** ISO-8601 with offset — when the version became effective. */
  readonly publishedAt: string;
  readonly versionNo: number;
}

/** The identity a tombstone (unpublish/archive) carries — nothing to project. */
export interface ArticleUnpublishedDescriptor {
  readonly articleId: string;
  readonly slug: string;
}

/**
 * Raised when the outbox append rejects a content search event (a producer-side
 * validation failure). Thrown INSIDE the publish transaction so the whole
 * publish rolls back — a published article that cannot durably queue its index
 * signal must not go live (the outbox invariant, CLAUDE.md §5.3). In practice
 * unreachable: the payload is built from typed inputs validated against the same
 * registry schema, so this guards a future schema/skew drift.
 */
export class ContentSearchEmitFailedError extends Error {
  constructor(
    readonly articleId: string,
    readonly eventName: string,
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`${eventName} payload validation failed for article '${articleId}'`);
    this.name = 'ContentSearchEmitFailedError';
  }
}

/**
 * Derive a bounded, plain-text-ish excerpt from a Markdown body for the search
 * result snippet. A simple whitespace-collapsed truncate — a proper
 * Markdown-strip is a consumer/indexer refinement (TS-286-followup-1); this is
 * the seam. Returns null for an empty body.
 */
export function deriveExcerpt(body: string): string | null {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  if (collapsed.length <= CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH) return collapsed;
  return collapsed.slice(0, CONTENT_SEARCH_EVENT_EXCERPT_MAX_LENGTH);
}

/**
 * Emits the content search-indexing events (TS-286; PDD §14.2, §19.3;
 * CLAUDE.md §5.3) to the transactional outbox.
 *
 * Call `emitPublished(tx, descriptor)` from INSIDE the publish `$transaction`
 * so the index signal commits atomically with the version going live. The relay
 * (`worker-outbox-relay`) already drains `content.outbox_events` (TS-284) — a
 * new event NAME on the same table needs no relay-config change. The (carved)
 * `worker-search-indexer` consumer (TS-286-followup-1) is idempotent on
 * `eventId`. Sibling to `ContentLegalEmitter` / `AuditEmitter` (the same
 * in-tx append shape).
 */
@Injectable()
export class ContentSearchEmitter {
  private readonly logger = new Logger(ContentSearchEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emitPublished(
    tx: OutboxRawExecutor,
    descriptor: ArticlePublishedDescriptor,
  ): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: ContentArticlePublished = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      articleId: descriptor.articleId,
      slug: descriptor.slug,
      title: descriptor.title,
      excerpt: deriveExcerpt(descriptor.body),
      body: descriptor.body,
      categoryId: descriptor.categoryId,
      authorIds: [...descriptor.authorIds],
      seoTitle: descriptor.seoTitle,
      metaDescription: descriptor.metaDescription,
      publishedAt: descriptor.publishedAt,
      versionNo: descriptor.versionNo,
    };

    const result = await this.outbox.append(tx, {
      eventName: CONTENT_ARTICLE_PUBLISHED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new ContentSearchEmitFailedError(
        descriptor.articleId,
        CONTENT_ARTICLE_PUBLISHED,
        result.issues,
      );
    }

    this.logger.log(
      {
        articleId: descriptor.articleId,
        slug: descriptor.slug,
        versionNo: descriptor.versionNo,
        eventId,
      },
      'content.article.published emitted',
    );
  }

  /**
   * Emit the tombstone so the indexer removes the doc. Not yet wired to a caller
   * — the unpublish/archive path is carved (TS-281-followup-1); provided now so
   * that path drops in without touching the emitter.
   */
  async emitUnpublished(
    tx: OutboxRawExecutor,
    descriptor: ArticleUnpublishedDescriptor,
  ): Promise<void> {
    const eventId = randomUUID();
    const occurredAt = new Date();
    const payload: ContentArticleUnpublished = {
      eventId,
      occurredAt: occurredAt.toISOString(),
      articleId: descriptor.articleId,
      slug: descriptor.slug,
    };

    const result = await this.outbox.append(tx, {
      eventName: CONTENT_ARTICLE_UNPUBLISHED,
      payload,
      eventId,
      occurredAt,
    });
    if (result.kind !== 'appended') {
      throw new ContentSearchEmitFailedError(
        descriptor.articleId,
        CONTENT_ARTICLE_UNPUBLISHED,
        result.issues,
      );
    }

    this.logger.log(
      { articleId: descriptor.articleId, slug: descriptor.slug, eventId },
      'content.article.unpublished emitted',
    );
  }
}
