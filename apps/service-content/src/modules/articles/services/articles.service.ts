import { Injectable, Logger } from '@nestjs/common';
import type {
  ArticleComments,
  ArticleCommentsProvider,
  ArticleDetail,
  ArticleRecord,
  ArticleSeo,
  ArticleVersionRecord,
  ContentStatus,
  CreateArticleRequest,
  CreateArticleVersionRequest,
  TwitterCard,
  UpdateArticleCommentsRequest,
  UpdateArticleRequest,
  UpdateArticleSeoRequest,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import { CONTENT_AUDIT_RESOURCE } from '../../audit/audit-resources';
import { ContentSearchEmitter, deriveExcerpt } from '../../audit/content-search-emitter';
import { ContentNewsletterEmitter } from '../../audit/content-newsletter-emitter';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import {
  ArticleRepository,
  type ArticleCommentsRow,
  type ArticleRow,
  type ArticleSeoRow,
  type ArticleVersionRow,
} from '../repositories/article.repository';

export interface CreateArticleInput extends CreateArticleRequest {
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface UpdateArticleInput extends UpdateArticleRequest {
  readonly articleId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface AppendVersionInput extends CreateArticleVersionRequest {
  readonly articleId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface PublishVersionInput {
  readonly articleId: string;
  readonly versionId: string;
  /** Explicit compliance-effective date, or undefined = "effective now". */
  readonly effectiveAt: string | undefined;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface UpdateArticleSeoInput extends UpdateArticleSeoRequest {
  readonly articleId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface UpdateArticleCommentsInput extends UpdateArticleCommentsRequest {
  readonly articleId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface ListArticlesInput {
  readonly status?: ContentStatus | undefined;
  readonly categoryId?: string | undefined;
  readonly limit: number;
}

export interface SendNewsletterInput {
  readonly articleId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export type CreateArticleOutcome =
  | { readonly ok: true; readonly article: ArticleRecord }
  | { readonly ok: false; readonly reason: 'slug_conflict' }
  | { readonly ok: false; readonly reason: 'category_not_found' };

export type UpdateArticleOutcome =
  | { readonly ok: true; readonly article: ArticleRecord }
  | { readonly ok: false; readonly reason: 'article_not_found' }
  | { readonly ok: false; readonly reason: 'category_not_found' };

export type AppendVersionOutcome =
  | { readonly ok: true; readonly version: ArticleVersionRecord }
  | { readonly ok: false; readonly reason: 'article_not_found' };

export type UpdateSeoOutcome =
  | { readonly ok: true; readonly seo: ArticleSeo }
  | { readonly ok: false; readonly reason: 'article_not_found' };

export type UpdateCommentsOutcome =
  | { readonly ok: true; readonly comments: ArticleComments }
  | { readonly ok: false; readonly reason: 'article_not_found' };

export type PublishVersionOutcome =
  | { readonly ok: true; readonly article: ArticleRecord }
  | { readonly ok: false; readonly reason: 'article_not_found' }
  | { readonly ok: false; readonly reason: 'version_not_found' }
  | { readonly ok: false; readonly reason: 'article_archived' };

export type SendNewsletterOutcome =
  | { readonly ok: true; readonly newsletterSentAt: string }
  | { readonly ok: false; readonly reason: 'article_not_found' }
  | { readonly ok: false; readonly reason: 'not_published' }
  | { readonly ok: false; readonly reason: 'already_sent' };

export type GetArticleOutcome =
  | { readonly ok: true; readonly article: ArticleDetail }
  | { readonly ok: false; readonly reason: 'not_found' };

export type GetVersionOutcome =
  | { readonly ok: true; readonly version: ArticleVersionRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

/**
 * Blog/help-article admin service (TS-284-followup-3; PRD §10.10, §10.11; PDD
 * §19). Mirrors `PagesService` — slug-uniqueness on create, monotonic per-article
 * version numbering, and the publish lifecycle — adding editorial-metadata
 * updates (title / category) and category-assignment validation. Every mutation
 * emits `audit.action_recorded` atomically with the write (CLAUDE.md §3.6).
 * Authorisation lives at the controller boundary.
 */
@Injectable()
export class ArticlesService {
  private readonly logger = new Logger(ArticlesService.name);

  constructor(
    private readonly repo: ArticleRepository,
    private readonly audit: AuditEmitter,
    private readonly search: ContentSearchEmitter,
    private readonly newsletter: ContentNewsletterEmitter,
  ) {}

  /** Create an article shell in `draft`. Duplicate slug → 409; bad category → 404. */
  async createArticle(input: CreateArticleInput): Promise<CreateArticleOutcome> {
    const existing = await this.repo.findArticleBySlug(input.slug);
    if (existing !== null) return { ok: false, reason: 'slug_conflict' };

    if (input.categoryId !== undefined) {
      const exists = await this.repo.helpCategoryExists(input.categoryId);
      if (!exists) return { ok: false, reason: 'category_not_found' };
    }

    const created = await this.repo.createArticle(
      { slug: input.slug, title: input.title, categoryId: input.categoryId ?? null },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_article:create',
          resourceKind: CONTENT_AUDIT_RESOURCE.article,
          resourceId: row.id,
          before: null,
          after: toArticleRecord(row),
        });
      },
    );

    this.logger.log(
      { articleId: created.id, slug: created.slug, actorUserId: input.actorUserId },
      'content article created',
    );
    return { ok: true, article: toArticleRecord(created) };
  }

  /** Update editorial metadata (title / category). Missing article → 404. */
  async updateArticle(input: UpdateArticleInput): Promise<UpdateArticleOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };

    if (input.categoryId !== undefined && input.categoryId !== null) {
      const exists = await this.repo.helpCategoryExists(input.categoryId);
      if (!exists) return { ok: false, reason: 'category_not_found' };
    }

    const before = toArticleRecord(article);
    const updated = await this.repo.updateArticle(
      input.articleId,
      { title: input.title, categoryId: input.categoryId },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_article:update',
          resourceKind: CONTENT_AUDIT_RESOURCE.article,
          resourceId: row.id,
          before,
          after: toArticleRecord(row),
        });
      },
    );

    this.logger.log(
      { articleId: input.articleId, actorUserId: input.actorUserId },
      'content article updated',
    );
    return { ok: true, article: toArticleRecord(updated) };
  }

  /**
   * Partial-update the article's SEO metadata (TS-282). Missing article → 404.
   * A supplied field (incl. `null` to clear) is written; omitted fields are
   * untouched. Emits `content_article:seo_updated` atomically with the write.
   */
  async updateSeo(input: UpdateArticleSeoInput): Promise<UpdateSeoOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };

    const beforeRow = await this.repo.findSeo(input.articleId);
    const before = beforeRow === null ? null : toSeoRecord(beforeRow);

    const { articleId, actorUserId, audit, ...seoPatch } = input;
    const updated = await this.repo.updateSeo(articleId, seoPatch, async (tx, row) => {
      await this.audit.emit(tx as unknown as OutboxRawExecutor, audit, {
        action: 'content_article:seo_updated',
        resourceKind: CONTENT_AUDIT_RESOURCE.article,
        resourceId: articleId,
        before,
        after: toSeoRecord(row),
      });
    });

    this.logger.log({ articleId, actorUserId }, 'content article SEO updated');
    return { ok: true, seo: toSeoRecord(updated) };
  }

  /**
   * Partial-update the article's comments config (TS-289). Missing article →
   * 404. A supplied field (incl. `disqusIdentifier: null` to clear) is written;
   * omitted fields are untouched. Emits `content_article:comments_updated`
   * atomically with the write. Mirrors `updateSeo`.
   */
  async updateComments(input: UpdateArticleCommentsInput): Promise<UpdateCommentsOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };

    const beforeRow = await this.repo.findComments(input.articleId);
    const before = beforeRow === null ? null : toCommentsRecord(beforeRow);

    const { articleId, actorUserId, audit } = input;
    // Wire → column field names (`enabled` → `comments_enabled`, etc.).
    const commentsPatch = {
      ...(input.enabled !== undefined && { commentsEnabled: input.enabled }),
      ...(input.provider !== undefined && { commentsProvider: input.provider }),
      ...(input.disqusIdentifier !== undefined && { disqusIdentifier: input.disqusIdentifier }),
    };
    const updated = await this.repo.updateComments(articleId, commentsPatch, async (tx, row) => {
      await this.audit.emit(tx as unknown as OutboxRawExecutor, audit, {
        action: 'content_article:comments_updated',
        resourceKind: CONTENT_AUDIT_RESOURCE.article,
        resourceId: articleId,
        before,
        after: toCommentsRecord(row),
      });
    });

    this.logger.log({ articleId, actorUserId }, 'content article comments config updated');
    return { ok: true, comments: toCommentsRecord(updated) };
  }

  /** Append a new revision to an article. A missing article is a 404. */
  async appendVersion(input: AppendVersionInput): Promise<AppendVersionOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };

    const created = await this.repo.appendVersion(
      input.articleId,
      { title: input.title, body: input.body, createdBy: input.actorUserId },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_article_version:create',
          resourceKind: CONTENT_AUDIT_RESOURCE.articleVersion,
          resourceId: row.id,
          before: null,
          after: toVersionRecord(row),
        });
      },
    );

    this.logger.log(
      {
        articleId: input.articleId,
        versionId: created.id,
        versionNo: created.versionNo,
        actorUserId: input.actorUserId,
      },
      'content article version appended',
    );
    return { ok: true, version: toVersionRecord(created) };
  }

  /**
   * Publish a version live. Resolution order:
   *   1. `article_not_found` — the article does not resolve.
   *   2. `version_not_found` — the version does not resolve on that article.
   *   3. `article_archived` — an archived article cannot be (re)published.
   * Only then does the write fire (stamp `effectiveAt`, repoint the head, move
   * the article to `published`).
   */
  async publishVersion(input: PublishVersionInput): Promise<PublishVersionOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };

    const version = await this.repo.findVersion(input.articleId, input.versionId);
    if (version === null) return { ok: false, reason: 'version_not_found' };

    if (article.status === 'archived') return { ok: false, reason: 'article_archived' };

    const effectiveAt = input.effectiveAt !== undefined ? new Date(input.effectiveAt) : new Date();
    const before = toArticleRecord(article);

    // Search-projection inputs read just before the publish (SEO + ordered
    // byline). Read outside the tx — a search projection is eventually
    // consistent (re-emitted on every publish), so a benign author/SEO race is
    // acceptable and avoids widening the publish transaction.
    const seo = await this.repo.findSeo(input.articleId);
    const authorIds = await this.repo.listArticleAuthorIds(input.articleId);

    const result = await this.repo.publishVersion(
      input.articleId,
      input.versionId,
      effectiveAt,
      async (tx, rows) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_article:publish',
          resourceKind: CONTENT_AUDIT_RESOURCE.article,
          resourceId: rows.article.id,
          before,
          after: toArticleRecord(rows.article),
        });
        // Search-index signal, atomic with the publish (CLAUDE.md §5.3). The
        // published version's title/body is the ES-document source; SEO +
        // byline enrich it.
        await this.search.emitPublished(tx as unknown as OutboxRawExecutor, {
          articleId: rows.article.id,
          slug: rows.article.slug,
          title: rows.version.title,
          body: rows.version.body,
          categoryId: rows.article.categoryId,
          authorIds,
          seoTitle: seo?.seoTitle ?? null,
          metaDescription: seo?.metaDescription ?? null,
          publishedAt: (rows.version.effectiveAt ?? effectiveAt).toISOString(),
          versionNo: rows.version.versionNo,
        });
      },
    );

    this.logger.log(
      {
        articleId: input.articleId,
        versionId: input.versionId,
        versionNo: result.version.versionNo,
        effectiveAt: effectiveAt.toISOString(),
        actorUserId: input.actorUserId,
      },
      'content article version published',
    );
    return { ok: true, article: toArticleRecord(result.article) };
  }

  /**
   * Trigger a per-post newsletter send (TS-288). Resolution order:
   *   1. `article_not_found` — the article does not resolve.
   *   2. `not_published`     — only a published post can be sent.
   *   3. `already_sent`      — `newsletterSentAt` is already set (the
   *      double-send guard; `@Idempotent()` collapses retries of the SAME
   *      request, this guards a fresh re-send).
   * Only then does the send fire: stamp `newsletterSentAt`/`newsletterSentBy`
   * and, in the SAME transaction, emit the `audit.action_recorded` trail (this
   * IS an admin mutation) AND append `content.newsletter.send_requested` to the
   * outbox so the (carved) `service-notification` consumer fans the post out to
   * opt-in subscribers.
   */
  async sendToNewsletter(input: SendNewsletterInput): Promise<SendNewsletterOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };
    if (article.status !== 'published' || article.currentVersionId === null) {
      return { ok: false, reason: 'not_published' };
    }
    if (article.newsletterSentAt !== null) return { ok: false, reason: 'already_sent' };

    // Marketing-email source facts, read just before the send. The published
    // head version supplies the title/body/effectiveAt; SEO enriches the
    // subject/preview. Read outside the tx — the send is a one-shot guard and
    // these are stable for a published article.
    const version = await this.repo.findVersion(input.articleId, article.currentVersionId);
    const seo = await this.repo.findSeo(input.articleId);
    const sentAt = new Date();
    const before = toArticleRecord(article);

    const updated = await this.repo.markNewsletterSent(
      input.articleId,
      sentAt,
      input.actorUserId,
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_article:newsletter_requested',
          resourceKind: CONTENT_AUDIT_RESOURCE.article,
          resourceId: row.id,
          before,
          after: toArticleRecord(row),
        });
        await this.newsletter.emit(tx as unknown as OutboxRawExecutor, {
          articleId: row.id,
          slug: row.slug,
          title: version?.title ?? row.title,
          excerpt: version === null ? null : deriveExcerpt(version.body),
          seoTitle: seo?.seoTitle ?? null,
          metaDescription: seo?.metaDescription ?? null,
          publishedAt: (version?.effectiveAt ?? sentAt).toISOString(),
          requestedByUserId: input.actorUserId,
        });
      },
    );

    this.logger.log(
      { articleId: input.articleId, slug: updated.slug, actorUserId: input.actorUserId },
      'content article sent to newsletter',
    );
    return { ok: true, newsletterSentAt: (updated.newsletterSentAt ?? sentAt).toISOString() };
  }

  /** Matching articles ordered by `createdAt` descending. */
  async listArticles(input: ListArticlesInput): Promise<readonly ArticleRecord[]> {
    const rows = await this.repo.listArticles({
      status: input.status,
      categoryId: input.categoryId,
      limit: input.limit,
    });
    return rows.map(toArticleRecord);
  }

  /** Article detail with its version history (newest-first). */
  async getArticleDetail(articleId: string): Promise<GetArticleOutcome> {
    const detail = await this.repo.findDetail(articleId);
    if (detail === null) return { ok: false, reason: 'not_found' };

    const article: ArticleDetail = {
      ...toArticleRecord(detail.article),
      versions: detail.versions.map(toVersionRecord),
      seo: toSeoRecord(detail.seo),
      comments: toCommentsRecord(detail.comments),
    };
    return { ok: true, article };
  }

  /** A single version (the compliance-reachable read). A miss is a 404. */
  async getVersion(articleId: string, versionId: string): Promise<GetVersionOutcome> {
    const version = await this.repo.findVersion(articleId, versionId);
    if (version === null) return { ok: false, reason: 'not_found' };
    return { ok: true, version: toVersionRecord(version) };
  }
}

// ─── Row → wire-record mappers ──────────────────────────────────────────

/** Project a persisted article row into the wire `ArticleRecord`. */
export function toArticleRecord(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    title: row.title,
    categoryId: row.categoryId,
    currentVersionId: row.currentVersionId,
    newsletterSentAt: row.newsletterSentAt === null ? null : row.newsletterSentAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a persisted version row into the wire `ArticleVersionRecord`. */
export function toVersionRecord(row: ArticleVersionRow): ArticleVersionRecord {
  return {
    id: row.id,
    articleId: row.articleId,
    versionNo: row.versionNo,
    title: row.title,
    body: row.body,
    effectiveAt: row.effectiveAt === null ? null : row.effectiveAt.toISOString(),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** True only for a plain JSON object (rejects arrays + primitives; a cleared
 *  `json_ld` column reads back as SQL NULL → JS null → false). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** A persisted `twitter_card` string narrowed to the wire enum (or null). */
function toTwitterCard(value: string | null): TwitterCard | null {
  return value === 'summary' || value === 'summary_large_image' ? value : null;
}

/** A persisted `comments_provider` string narrowed to the wire enum. An
 *  unrecognised value degrades to `none` (comments dark) rather than throwing —
 *  the column defaults to `disqus` so this only fires on a bad manual write. */
function toCommentsProvider(value: string): ArticleCommentsProvider {
  return value === 'disqus' ? 'disqus' : 'none';
}

/** Project the persisted comments columns into the wire `ArticleComments` block. */
export function toCommentsRecord(row: ArticleCommentsRow): ArticleComments {
  return {
    enabled: row.commentsEnabled ?? false,
    provider: toCommentsProvider(row.commentsProvider ?? 'disqus'),
    disqusIdentifier: row.disqusIdentifier ?? null,
  };
}

/** Project the persisted SEO columns into the wire `ArticleSeo` block. */
export function toSeoRecord(row: ArticleSeoRow): ArticleSeo {
  return {
    seoTitle: row.seoTitle ?? null,
    metaDescription: row.metaDescription ?? null,
    canonicalUrl: row.canonicalUrl ?? null,
    ogTitle: row.ogTitle ?? null,
    ogDescription: row.ogDescription ?? null,
    ogImageKey: row.ogImageKey ?? null,
    twitterCard: toTwitterCard(row.twitterCard ?? null),
    twitterTitle: row.twitterTitle ?? null,
    twitterDescription: row.twitterDescription ?? null,
    twitterImageKey: row.twitterImageKey ?? null,
    jsonLd: isJsonObject(row.jsonLd) ? row.jsonLd : null,
  };
}
