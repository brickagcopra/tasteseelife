import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  ArticleFeedbackResponseSchema,
  ListRelatedArticlesQuerySchema,
  RelatedArticlesResponseSchema,
  SubmitArticleFeedbackRequestSchema,
  type ArticleFeedbackResponse,
  type ListRelatedArticlesQuery,
  type RelatedArticlesResponse,
  type SubmitArticleFeedbackRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { FeedbackService } from '../services/feedback.service';
import { RelatedArticlesService } from '../services/related-articles.service';

/**
 * End-user article-engagement HTTP boundary (TS-287; PRD §10.10, §10.11; PDD
 * §19.3) — "Was this helpful?" feedback + related-article suggestions.
 *
 *   PUT /api/v1/content/articles/:articleId/feedback  — cast / change my vote.  authenticated user.
 *   GET /api/v1/content/articles/:articleId/feedback  — aggregate + my vote.    authenticated user.
 *   GET /api/v1/content/articles/:articleId/related   — related articles.       authenticated user.
 *
 * Unlike the admin authoring surfaces (`/api/v1/admin/content/...`, gated on the
 * `content:*` permissions), these are USER-FACING: any authenticated reader
 * (family / senior / staff). They sit behind `AccessTokenGuard` only — NO
 * `@RequirePermissions` / `PermissionGuard` — and the vote is keyed by the
 * verified token's `userId` (never the body). The PUT is `@Idempotent()` so a
 * client retry collapses. Feedback / related are only served on PUBLISHED
 * articles; a draft/archived/missing article is a uniform 404 (no draft-existence
 * leak).
 */
@Controller()
export class FeedbackController {
  constructor(
    private readonly feedback: FeedbackService,
    private readonly related: RelatedArticlesService,
  ) {}

  @Put('api/v1/content/articles/:articleId/feedback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async submit(
    @Param('articleId') articleId: string,
    @Body(new ZodValidationPipe(SubmitArticleFeedbackRequestSchema))
    body: SubmitArticleFeedbackRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleFeedbackResponse> {
    const ctx = requireContext(request);
    const outcome = await this.feedback.submit({
      articleId,
      userId: ctx.userId,
      rating: body.rating,
    });
    if (!outcome.ok) throw articleNotFound(articleId);
    return ArticleFeedbackResponseSchema.parse({ feedback: outcome.summary });
  }

  @Get('api/v1/content/articles/:articleId/feedback')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async summary(
    @Param('articleId') articleId: string,
    @Req() request: RequestWithContext,
  ): Promise<ArticleFeedbackResponse> {
    const ctx = requireContext(request);
    const outcome = await this.feedback.getSummary(articleId, ctx.userId);
    if (!outcome.ok) throw articleNotFound(articleId);
    return ArticleFeedbackResponseSchema.parse({ feedback: outcome.summary });
  }

  @Get('api/v1/content/articles/:articleId/related')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async relatedArticles(
    @Param('articleId') articleId: string,
    @Query(new ZodValidationPipe(ListRelatedArticlesQuerySchema))
    query: ListRelatedArticlesQuery,
    @Req() request: RequestWithContext,
  ): Promise<RelatedArticlesResponse> {
    // AccessTokenGuard populates the context; the read itself is not user-scoped
    // but the surface is authenticated (same posture as the feedback reads).
    requireContext(request);
    const outcome = await this.related.getRelated(articleId, query.limit);
    if (!outcome.ok) throw articleNotFound(articleId);
    return RelatedArticlesResponseSchema.parse({ related: [...outcome.related] });
  }
}

function articleNotFound(articleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No published content article found for id '${articleId}'.`,
  });
}

function requireContext(request: RequestWithContext): RequestContext {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx;
}
