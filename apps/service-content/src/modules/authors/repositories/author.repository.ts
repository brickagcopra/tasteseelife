import { Injectable } from '@nestjs/common';
import type { ContentAuthorRole } from '@taste-and-see/contracts';

import type { Prisma } from '../../../../prisma/generated';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Local mirrors of the Prisma-generated `content_authors` / `article_authors`
 * rows, narrowed to the columns this module reads/writes. Same rationale as the
 * article/page repositories — Prisma's row types resolve inconsistently under
 * our tsconfig, so shapes are projected by hand.
 */
export interface ContentAuthorRow {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly photoAssetKey: string | null;
  /** JSONB — a social-links object or null. Validated at the contract boundary. */
  readonly socialLinks: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** An `article_authors` link joined to its author row (the byline read shape). */
export interface ArticleAuthorRow {
  readonly role: ContentAuthorRole;
  readonly sortOrder: number;
  readonly author: ContentAuthorRow;
}

/** Explicit column projection — never `SELECT *` (CLAUDE.md §4.1). */
const AUTHOR_SELECT = {
  id: true,
  userId: true,
  displayName: true,
  bio: true,
  photoAssetKey: true,
  socialLinks: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface ContentAuthorWriteData {
  readonly userId: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly photoAssetKey: string | null;
  /** A social-links object, or null. */
  readonly socialLinks: unknown | null;
}

/**
 * Author-profile partial update. A present field is written (`null` clears);
 * an omitted field is untouched. Scalars patch through the ORM; `socialLinks`
 * writes a value through the ORM but clears to DB NULL via a raw `UPDATE` (the
 * `Prisma.DbNull` sentinel is unavailable in this project — the TS-282 quirk).
 */
export interface ContentAuthorUpdateData {
  readonly displayName?: string | undefined;
  readonly bio?: string | null | undefined;
  readonly photoAssetKey?: string | null | undefined;
  readonly socialLinks?: unknown | null | undefined;
}

/** One entry in the replace-set — which author, in what role, at what position. */
export interface ArticleAuthorLinkInput {
  readonly authorId: string;
  readonly role: ContentAuthorRole;
  readonly sortOrder: number;
}

/**
 * Persistence for the author-profile + article-byline aggregate (TS-283; PDD
 * §19.1). The `ContentAuthor` / `ArticleAuthor` models are `unscopedModel`s, so
 * the tenant-scope gate short-circuits. `onPersist` (when supplied) runs INSIDE
 * the mutation transaction (the audit-outbox append) so the audit row commits
 * atomically with the state change (CLAUDE.md §3.6, §5.3).
 */
@Injectable()
export class AuthorRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Create an author profile. */
  async createAuthor(
    data: ContentAuthorWriteData,
    onPersist?: (tx: PrismaTransactionClient, created: ContentAuthorRow) => Promise<void>,
  ): Promise<ContentAuthorRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = (await tx.contentAuthor.create({
        data: {
          userId: data.userId,
          displayName: data.displayName,
          bio: data.bio,
          photoAssetKey: data.photoAssetKey,
          // `socialLinks` is declared `unknown | null`, which collapses to
          // `unknown` — so a bare `!== null` guard narrows to `{} | undefined`
          // and still carries `undefined` into the create input. Both branches
          // are excluded and the value is asserted to the generated JSON input
          // alias; omitting the key leaves the nullable column at DB NULL
          // (TS-501).
          ...(data.socialLinks !== null &&
            data.socialLinks !== undefined && {
              socialLinks: data.socialLinks as Prisma.InputJsonValue,
            }),
        },
        select: AUTHOR_SELECT,
      })) as ContentAuthorRow;
      if (onPersist !== undefined) await onPersist(tx, created);
      return created;
    });
  }

  /** Update an author profile. `socialLinks: null` clears via a raw UPDATE. */
  async updateAuthor(
    id: string,
    data: ContentAuthorUpdateData,
    onPersist?: (tx: PrismaTransactionClient, updated: ContentAuthorRow) => Promise<void>,
  ): Promise<ContentAuthorRow> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const patch: Record<string, unknown> = {};
      if (data.displayName !== undefined) patch['displayName'] = data.displayName;
      if (data.bio !== undefined) patch['bio'] = data.bio;
      if (data.photoAssetKey !== undefined) patch['photoAssetKey'] = data.photoAssetKey;
      // A JSON *value* rides the ORM patch; a JSON *clear* is a raw NULL below.
      if (data.socialLinks !== undefined && data.socialLinks !== null) {
        patch['socialLinks'] = data.socialLinks;
      }

      if (Object.keys(patch).length > 0) {
        await tx.contentAuthor.update({ where: { id }, data: patch, select: { id: true } });
      }
      if (data.socialLinks === null) {
        await tx.$executeRawUnsafe(
          'UPDATE "content"."content_authors" SET "social_links" = NULL WHERE "id" = $1',
          id,
        );
      }

      const updated = (await tx.contentAuthor.findUnique({
        where: { id },
        select: AUTHOR_SELECT,
      })) as ContentAuthorRow;
      if (onPersist !== undefined) await onPersist(tx, updated);
      return updated;
    });
  }

  /** Author row by id, or null. */
  async findAuthor(id: string): Promise<ContentAuthorRow | null> {
    return (await this.prisma.contentAuthor.findUnique({
      where: { id },
      select: AUTHOR_SELECT,
    })) as ContentAuthorRow | null;
  }

  /** Author row by soft `userId` (the create-uniqueness guard), or null. */
  async findAuthorByUserId(userId: string): Promise<ContentAuthorRow | null> {
    return (await this.prisma.contentAuthor.findUnique({
      where: { userId },
      select: AUTHOR_SELECT,
    })) as ContentAuthorRow | null;
  }

  /** All authors ordered by `displayName` ascending. */
  async listAuthors(limit: number): Promise<readonly ContentAuthorRow[]> {
    return (await this.prisma.contentAuthor.findMany({
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: limit,
      select: AUTHOR_SELECT,
    })) as ContentAuthorRow[];
  }

  /** Article row by id (existence check for the byline set), or null. */
  async findArticle(id: string): Promise<{ readonly id: string } | null> {
    return (await this.prisma.article.findUnique({
      where: { id },
      select: { id: true },
    })) as { id: string } | null;
  }

  /** True when every supplied author id resolves to an existing author. */
  async allAuthorsExist(authorIds: readonly string[]): Promise<boolean> {
    if (authorIds.length === 0) return true;
    const found = (await this.prisma.contentAuthor.findMany({
      where: { id: { in: [...authorIds] } },
      select: { id: true },
    })) as ReadonlyArray<{ id: string }>;
    return found.length === new Set(authorIds).size;
  }

  /**
   * REPLACE an article's complete author set inside one transaction: delete the
   * existing links, then insert the new ordered set. `onPersist` (the audit
   * append) runs inside the same transaction. Returns the new byline (joined +
   * ordered by `sortOrder`).
   */
  async setArticleAuthors(
    articleId: string,
    links: readonly ArticleAuthorLinkInput[],
    onPersist?: (tx: PrismaTransactionClient) => Promise<void>,
  ): Promise<readonly ArticleAuthorRow[]> {
    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await tx.articleAuthor.deleteMany({ where: { articleId } });
      for (const link of links) {
        await tx.articleAuthor.create({
          data: {
            articleId,
            authorId: link.authorId,
            authorRole: link.role,
            sortOrder: link.sortOrder,
          },
          select: { id: true },
        });
      }
      if (onPersist !== undefined) await onPersist(tx);
      return readArticleAuthors(tx as unknown as ArticleAuthorReader, articleId);
    });
  }

  /** The article's byline (joined + ordered by `sortOrder`). */
  async listArticleAuthors(articleId: string): Promise<readonly ArticleAuthorRow[]> {
    return readArticleAuthors(this.prisma as unknown as ArticleAuthorReader, articleId);
  }
}

/**
 * The minimal `articleAuthor.findMany` surface the byline reader needs — shared
 * by `PrismaService` and the `$transaction` client so the reader runs both
 * standalone and inside the set transaction.
 */
interface ArticleAuthorReader {
  readonly articleAuthor: {
    findMany(args: unknown): Promise<
      ReadonlyArray<{
        authorRole: ContentAuthorRole;
        sortOrder: number;
        author: ContentAuthorRow;
      }>
    >;
  };
}

/** Read an article's byline (joined + ordered by `(sortOrder, id)`). */
async function readArticleAuthors(
  client: ArticleAuthorReader,
  articleId: string,
): Promise<readonly ArticleAuthorRow[]> {
  const links = await client.articleAuthor.findMany({
    where: { articleId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      authorRole: true,
      sortOrder: true,
      author: { select: AUTHOR_SELECT },
    },
  });
  return links.map((l) => ({ role: l.authorRole, sortOrder: l.sortOrder, author: l.author }));
}
