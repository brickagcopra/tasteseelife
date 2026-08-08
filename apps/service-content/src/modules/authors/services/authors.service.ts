import { Injectable, Logger } from '@nestjs/common';
import type {
  ArticleAuthor,
  AuthorSocialLinks,
  ContentAuthorRecord,
  ContentAuthorRole,
  CreateContentAuthorRequest,
  SetArticleAuthorEntry,
  UpdateContentAuthorRequest,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { AuditEmitter } from '@taste-and-see/nest-audit';
import { CONTENT_AUDIT_RESOURCE } from '../../audit/audit-resources';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import {
  AuthorRepository,
  type ArticleAuthorRow,
  type ContentAuthorRow,
} from '../repositories/author.repository';

export interface CreateAuthorInput extends CreateContentAuthorRequest {
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface UpdateAuthorInput extends UpdateContentAuthorRequest {
  readonly authorId: string;
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export interface SetArticleAuthorsInput {
  readonly articleId: string;
  readonly authors: readonly SetArticleAuthorEntry[];
  readonly actorUserId: string;
  readonly audit: AuditActorContext;
}

export type CreateAuthorOutcome =
  | { readonly ok: true; readonly author: ContentAuthorRecord }
  | { readonly ok: false; readonly reason: 'user_conflict' };

export type UpdateAuthorOutcome =
  | { readonly ok: true; readonly author: ContentAuthorRecord }
  | { readonly ok: false; readonly reason: 'author_not_found' };

export type GetAuthorOutcome =
  | { readonly ok: true; readonly author: ContentAuthorRecord }
  | { readonly ok: false; readonly reason: 'not_found' };

export type SetArticleAuthorsOutcome =
  | { readonly ok: true; readonly authors: readonly ArticleAuthor[] }
  | { readonly ok: false; readonly reason: 'article_not_found' }
  | { readonly ok: false; readonly reason: 'author_not_found' };

/**
 * Author-profile + article-byline admin service (TS-283; PRD §10.10; PDD §19.1).
 * Owns the `userId`-uniqueness rule on create, the partial-update semantics, and
 * the replace-set byline assignment (validate the article + every author exists,
 * then swap the ordered credit set). Every mutation emits `audit.action_recorded`
 * atomically with the write (CLAUDE.md §3.6). Authorisation lives at the
 * controller boundary.
 */
@Injectable()
export class AuthorsService {
  private readonly logger = new Logger(AuthorsService.name);

  constructor(
    private readonly repo: AuthorRepository,
    private readonly audit: AuditEmitter,
  ) {}

  /** Create an author profile. Duplicate `userId` → 409. */
  async createAuthor(input: CreateAuthorInput): Promise<CreateAuthorOutcome> {
    const existing = await this.repo.findAuthorByUserId(input.userId);
    if (existing !== null) return { ok: false, reason: 'user_conflict' };

    const created = await this.repo.createAuthor(
      {
        userId: input.userId,
        displayName: input.displayName,
        bio: input.bio ?? null,
        photoAssetKey: input.photoAssetKey ?? null,
        socialLinks: input.socialLinks ?? null,
      },
      async (tx, row) => {
        await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'content_author:create',
          resourceKind: CONTENT_AUDIT_RESOURCE.author,
          resourceId: row.id,
          before: null,
          after: toAuthorRecord(row),
        });
      },
    );

    this.logger.log(
      { authorId: created.id, userId: created.userId, actorUserId: input.actorUserId },
      'content author created',
    );
    return { ok: true, author: toAuthorRecord(created) };
  }

  /** Update an author profile. Missing author → 404. */
  async updateAuthor(input: UpdateAuthorInput): Promise<UpdateAuthorOutcome> {
    const author = await this.repo.findAuthor(input.authorId);
    if (author === null) return { ok: false, reason: 'author_not_found' };

    const before = toAuthorRecord(author);
    const { authorId, actorUserId, audit, ...patch } = input;
    const updated = await this.repo.updateAuthor(authorId, patch, async (tx, row) => {
      await this.audit.emit(tx as unknown as OutboxRawExecutor, audit, {
        action: 'content_author:update',
        resourceKind: CONTENT_AUDIT_RESOURCE.author,
        resourceId: authorId,
        before,
        after: toAuthorRecord(row),
      });
    });

    this.logger.log({ authorId, actorUserId }, 'content author updated');
    return { ok: true, author: toAuthorRecord(updated) };
  }

  /** All author profiles (ordered by display name). */
  async listAuthors(limit: number): Promise<readonly ContentAuthorRecord[]> {
    const rows = await this.repo.listAuthors(limit);
    return rows.map(toAuthorRecord);
  }

  /** A single author profile. A miss is a 404. */
  async getAuthor(authorId: string): Promise<GetAuthorOutcome> {
    const author = await this.repo.findAuthor(authorId);
    if (author === null) return { ok: false, reason: 'not_found' };
    return { ok: true, author: toAuthorRecord(author) };
  }

  /** An article's current byline (ordered). A missing article is a 404. */
  async getArticleAuthors(
    articleId: string,
  ): Promise<
    | { readonly ok: true; readonly authors: readonly ArticleAuthor[] }
    | { readonly ok: false; readonly reason: 'article_not_found' }
  > {
    const article = await this.repo.findArticle(articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };
    const links = await this.repo.listArticleAuthors(articleId);
    return { ok: true, authors: links.map(toArticleAuthor) };
  }

  /**
   * REPLACE an article's ordered author set. Resolution order:
   *   1. `article_not_found` — the article does not resolve.
   *   2. `author_not_found`  — some supplied author id does not resolve.
   * `sortOrder` is assigned from array position. Emits `content_article:authors_set`
   * atomically with the replace.
   */
  async setArticleAuthors(input: SetArticleAuthorsInput): Promise<SetArticleAuthorsOutcome> {
    const article = await this.repo.findArticle(input.articleId);
    if (article === null) return { ok: false, reason: 'article_not_found' };

    const authorIds = input.authors.map((a) => a.authorId);
    const allExist = await this.repo.allAuthorsExist(authorIds);
    if (!allExist) return { ok: false, reason: 'author_not_found' };

    const before = await this.repo.listArticleAuthors(input.articleId);
    const links = input.authors.map((a, index) => ({
      authorId: a.authorId,
      role: a.role,
      sortOrder: index,
    }));

    const result = await this.repo.setArticleAuthors(input.articleId, links, async (tx) => {
      await this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
        action: 'content_article:authors_set',
        resourceKind: CONTENT_AUDIT_RESOURCE.article,
        resourceId: input.articleId,
        before: before.map(toArticleAuthor),
        after: links,
      });
    });

    this.logger.log(
      { articleId: input.articleId, authorCount: links.length, actorUserId: input.actorUserId },
      'content article authors set',
    );
    return { ok: true, authors: result.map(toArticleAuthor) };
  }
}

// ─── Row → wire-record mappers ──────────────────────────────────────────

/** True only for a plain JSON object (rejects arrays + primitives + null). */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Narrow a persisted `social_links` JSON blob to the wire shape (or null). */
function toSocialLinks(value: unknown): AuthorSocialLinks | null {
  return isJsonObject(value) ? (value as AuthorSocialLinks) : null;
}

/** Project a persisted author row into the wire `ContentAuthorRecord`. */
export function toAuthorRecord(row: ContentAuthorRow): ContentAuthorRecord {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    bio: row.bio,
    photoAssetKey: row.photoAssetKey,
    socialLinks: toSocialLinks(row.socialLinks),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Project a joined byline row into the wire `ArticleAuthor`. */
export function toArticleAuthor(row: ArticleAuthorRow): ArticleAuthor {
  return {
    role: row.role as ContentAuthorRole,
    sortOrder: row.sortOrder,
    author: toAuthorRecord(row.author),
  };
}
