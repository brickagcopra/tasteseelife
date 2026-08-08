import { Injectable } from '@nestjs/common';
import type { ArticleFeedbackRating, ContentStatus } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The bounded article shape the feedback surface needs for its existence /
 * published gate (never `SELECT *`).
 */
export interface FeedbackArticleRow {
  readonly id: string;
  readonly status: ContentStatus;
  readonly categoryId: string | null;
}

/** A published candidate article + its credited author ids (for related ranking). */
export interface RelatedCandidateRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly categoryId: string | null;
  readonly authorIds: readonly string[];
}

/** Aggregate helpful / not-helpful counts for an article. */
export interface FeedbackCounts {
  readonly helpfulCount: number;
  readonly notHelpfulCount: number;
}

/**
 * Max published articles pulled into the related-articles candidate pool per
 * request. A documented Phase-2 simplification: rather than a bespoke
 * category/author candidate-generation query, we rank the most-recent published
 * articles. At Phase-1 content volume this is the full corpus; a proper
 * candidate-generation query (or an ML retrieval step) is the deferred followup.
 */
const RELATED_CANDIDATE_POOL_MAX = 200;

const FEEDBACK_ARTICLE_SELECT = {
  id: true,
  status: true,
  categoryId: true,
} as const;

const RELATED_ARTICLE_SELECT = {
  id: true,
  slug: true,
  title: true,
  categoryId: true,
} as const;

/**
 * Persistence for end-user article feedback + the related-articles candidate
 * pool (TS-287; PDD §19.3). The `article_feedback` table is an `unscopedModel`,
 * so the tenant-scope gate short-circuits (mirrors the other content
 * repositories). Aggregate counts are COMPUTED here (a `count` per rating) — no
 * denormalised counter to drift.
 */
@Injectable()
export class ArticleFeedbackRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The bounded article row (existence / published / category), or null. */
  async findArticle(articleId: string): Promise<FeedbackArticleRow | null> {
    return (await this.prisma.article.findUnique({
      where: { id: articleId },
      select: FEEDBACK_ARTICLE_SELECT,
    })) as FeedbackArticleRow | null;
  }

  /**
   * UPSERT the caller's vote (one row per (articleId, userId)). A re-vote flips
   * the `rating` on the existing row rather than inserting a duplicate.
   */
  async upsertVote(
    articleId: string,
    userId: string,
    rating: ArticleFeedbackRating,
  ): Promise<void> {
    await this.prisma.articleFeedback.upsert({
      where: { articleId_userId: { articleId, userId } },
      create: { articleId, userId, rating },
      update: { rating },
      select: { id: true },
    });
  }

  /** The caller's current rating on an article, or null when they have not voted. */
  async findOwnRating(articleId: string, userId: string): Promise<ArticleFeedbackRating | null> {
    const row = (await this.prisma.articleFeedback.findUnique({
      where: { articleId_userId: { articleId, userId } },
      select: { rating: true },
    })) as { rating: ArticleFeedbackRating } | null;
    return row?.rating ?? null;
  }

  /** Aggregate helpful / not-helpful counts, computed on read (a count per rating). */
  async countByRating(articleId: string): Promise<FeedbackCounts> {
    const [helpfulCount, notHelpfulCount] = await Promise.all([
      this.prisma.articleFeedback.count({ where: { articleId, rating: 'helpful' } }),
      this.prisma.articleFeedback.count({ where: { articleId, rating: 'not_helpful' } }),
    ]);
    return { helpfulCount, notHelpfulCount };
  }

  /** The target article's credited author ids (for related-article overlap scoring). */
  async findArticleAuthorIds(articleId: string): Promise<readonly string[]> {
    const rows = (await this.prisma.articleAuthor.findMany({
      where: { articleId },
      select: { authorId: true },
    })) as ReadonlyArray<{ authorId: string }>;
    return rows.map((r) => r.authorId);
  }

  /**
   * The related-articles candidate pool: the most-recent PUBLISHED articles
   * (excluding `excludeId`), each hydrated with its credited author ids. Bounded
   * by {@link RELATED_CANDIDATE_POOL_MAX}. Two queries total (articles, then their
   * author links grouped in memory) — no per-candidate N+1.
   */
  async findRelatedCandidates(excludeId: string): Promise<readonly RelatedCandidateRow[]> {
    const articles = (await this.prisma.article.findMany({
      where: { status: 'published' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RELATED_CANDIDATE_POOL_MAX + 1,
      select: RELATED_ARTICLE_SELECT,
    })) as ReadonlyArray<{
      id: string;
      slug: string;
      title: string;
      categoryId: string | null;
    }>;

    const pool = articles.filter((a) => a.id !== excludeId).slice(0, RELATED_CANDIDATE_POOL_MAX);
    if (pool.length === 0) return [];

    const links = (await this.prisma.articleAuthor.findMany({
      where: { articleId: { in: pool.map((a) => a.id) } },
      select: { articleId: true, authorId: true },
    })) as ReadonlyArray<{ articleId: string; authorId: string }>;

    const authorsByArticle = new Map<string, string[]>();
    for (const link of links) {
      const list = authorsByArticle.get(link.articleId) ?? [];
      list.push(link.authorId);
      authorsByArticle.set(link.articleId, list);
    }

    return pool.map((a) => ({
      id: a.id,
      slug: a.slug,
      title: a.title,
      categoryId: a.categoryId,
      authorIds: authorsByArticle.get(a.id) ?? [],
    }));
  }
}
