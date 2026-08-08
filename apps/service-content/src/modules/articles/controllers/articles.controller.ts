import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  ArticleCommentsResponseSchema,
  ArticleDetailResponseSchema,
  ArticleResponseSchema,
  ArticleSeoResponseSchema,
  ArticleVersionResponseSchema,
  ArticlesListResponseSchema,
  CreateArticleRequestSchema,
  CreateArticleVersionRequestSchema,
  ListArticlesQuerySchema,
  PublishArticleVersionRequestSchema,
  SendArticleNewsletterRequestSchema,
  SendArticleNewsletterResponseSchema,
  UpdateArticleCommentsRequestSchema,
  UpdateArticleRequestSchema,
  UpdateArticleSeoRequestSchema,
  type ArticleCommentsResponse,
  type ArticleDetailResponse,
  type ArticleResponse,
  type ArticleSeoResponse,
  type ArticleVersionResponse,
  type ArticlesListResponse,
  type CreateArticleRequest,
  type CreateArticleVersionRequest,
  type ListArticlesQuery,
  type PublishArticleVersionRequest,
  type SendArticleNewsletterRequest,
  type SendArticleNewsletterResponse,
  type UpdateArticleCommentsRequest,
  type UpdateArticleRequest,
  type UpdateArticleSeoRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { buildAuditActorContext } from '@taste-and-see/nest-audit';
import { ArticlesService } from '../services/articles.service';

/**
 * Blog / help-article CMS admin HTTP boundary (TS-284-followup-3; PRD §10.10,
 * §10.11; PDD §19). Mirrors `PagesController`; adds a metadata PATCH + the
 * `categoryId` axis.
 *
 *   GET   /api/v1/admin/content/articles                                  — list.    `content:read`.
 *   POST  /api/v1/admin/content/articles                                  — create.  `content:edit`.
 *   GET   /api/v1/admin/content/articles/:articleId                       — detail.  `content:read`.
 *   PATCH /api/v1/admin/content/articles/:articleId                       — update.  `content:edit`.
 *   PATCH /api/v1/admin/content/articles/:articleId/seo                   — SEO.     `content:edit`.
 *   PATCH /api/v1/admin/content/articles/:articleId/comments              — comments. `content:edit`.
 *   POST  /api/v1/admin/content/articles/:articleId/versions             — append.  `content:edit`.
 *   GET   /api/v1/admin/content/articles/:articleId/versions/:versionId  — version. `content:read`.
 *   POST  /api/v1/admin/content/articles/:articleId/versions/:versionId/publish — publish. `content:publish`.
 *
 * Authorisation, idempotency, and actor attribution mirror `PagesController`
 * (see its doc-block). Writes wear `@Idempotent()`; the acting staff id is the
 * verified token's `userId` (also the version's `createdBy`), never the body.
 */
@Controller()
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get('api/v1/admin/content/articles')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListArticlesQuerySchema))
    query: ListArticlesQuery,
  ): Promise<ArticlesListResponse> {
    const articles = await this.articles.listArticles({
      status: query.status,
      categoryId: query.categoryId,
      limit: query.limit,
    });
    return ArticlesListResponseSchema.parse({ articles: [...articles] });
  }

  @Post('api/v1/admin/content/articles')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateArticleRequestSchema))
    body: CreateArticleRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.articles.createArticle({
      ...body,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'category_not_found') throw categoryNotFound(body.categoryId ?? '');
      throw conflict(`An article with slug '${body.slug}' already exists.`);
    }
    return ArticleResponseSchema.parse({ article: outcome.article });
  }

  @Get('api/v1/admin/content/articles/:articleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('articleId') articleId: string): Promise<ArticleDetailResponse> {
    const outcome = await this.articles.getArticleDetail(articleId);
    if (!outcome.ok) throw articleNotFound(articleId);
    return ArticleDetailResponseSchema.parse({ article: outcome.article });
  }

  @Patch('api/v1/admin/content/articles/:articleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('articleId') articleId: string,
    @Body(new ZodValidationPipe(UpdateArticleRequestSchema))
    body: UpdateArticleRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.articles.updateArticle({
      ...body,
      articleId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'category_not_found') throw categoryNotFound(body.categoryId ?? '');
      throw articleNotFound(articleId);
    }
    return ArticleResponseSchema.parse({ article: outcome.article });
  }

  @Patch('api/v1/admin/content/articles/:articleId/seo')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async updateSeo(
    @Param('articleId') articleId: string,
    @Body(new ZodValidationPipe(UpdateArticleSeoRequestSchema))
    body: UpdateArticleSeoRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleSeoResponse> {
    const ctx = requireContext(request);
    const outcome = await this.articles.updateSeo({
      ...body,
      articleId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) throw articleNotFound(articleId);
    return ArticleSeoResponseSchema.parse({ seo: outcome.seo });
  }

  @Patch('api/v1/admin/content/articles/:articleId/comments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async updateComments(
    @Param('articleId') articleId: string,
    @Body(new ZodValidationPipe(UpdateArticleCommentsRequestSchema))
    body: UpdateArticleCommentsRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleCommentsResponse> {
    const ctx = requireContext(request);
    const outcome = await this.articles.updateComments({
      ...body,
      articleId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) throw articleNotFound(articleId);
    return ArticleCommentsResponseSchema.parse({ comments: outcome.comments });
  }

  @Post('api/v1/admin/content/articles/:articleId/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async appendVersion(
    @Param('articleId') articleId: string,
    @Body(new ZodValidationPipe(CreateArticleVersionRequestSchema))
    body: CreateArticleVersionRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleVersionResponse> {
    const ctx = requireContext(request);
    const outcome = await this.articles.appendVersion({
      ...body,
      articleId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) throw articleNotFound(articleId);
    return ArticleVersionResponseSchema.parse({ version: outcome.version });
  }

  @Get('api/v1/admin/content/articles/:articleId/versions/:versionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async version(
    @Param('articleId') articleId: string,
    @Param('versionId') versionId: string,
  ): Promise<ArticleVersionResponse> {
    const outcome = await this.articles.getVersion(articleId, versionId);
    if (!outcome.ok) throw versionNotFound(articleId, versionId);
    return ArticleVersionResponseSchema.parse({ version: outcome.version });
  }

  @Post('api/v1/admin/content/articles/:articleId/versions/:versionId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:publish')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async publish(
    @Param('articleId') articleId: string,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(PublishArticleVersionRequestSchema))
    body: PublishArticleVersionRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.articles.publishVersion({
      articleId,
      versionId,
      effectiveAt: body.effectiveAt,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'article_not_found':
          throw articleNotFound(articleId);
        case 'version_not_found':
          throw versionNotFound(articleId, versionId);
        case 'article_archived':
          throw conflict(`Article '${articleId}' is archived and cannot be published.`);
      }
    }
    return ArticleResponseSchema.parse({ article: outcome.article });
  }

  @Post('api/v1/admin/content/articles/:articleId/newsletter')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:publish')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async sendToNewsletter(
    @Param('articleId') articleId: string,
    @Body(new ZodValidationPipe(SendArticleNewsletterRequestSchema))
    _body: SendArticleNewsletterRequest,
    @Req() request: RequestWithContext,
  ): Promise<SendArticleNewsletterResponse> {
    const ctx = requireContext(request);
    const outcome = await this.articles.sendToNewsletter({
      articleId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'article_not_found':
          throw articleNotFound(articleId);
        case 'not_published':
          throw conflict(
            `Article '${articleId}' is not published and cannot be sent to the newsletter.`,
          );
        case 'already_sent':
          throw conflict(`Article '${articleId}' has already been sent to the newsletter.`);
      }
    }
    return SendArticleNewsletterResponseSchema.parse({
      newsletterSentAt: outcome.newsletterSentAt,
    });
  }
}

function articleNotFound(articleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No content article found for id '${articleId}'.`,
  });
}

function versionNotFound(articleId: string, versionId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No version '${versionId}' found on article '${articleId}'.`,
  });
}

function categoryNotFound(categoryId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No help category found for id '${categoryId}'.`,
  });
}

function conflict(detail: string): ConflictException {
  return new ConflictException({
    type: 'about:blank',
    title: 'Conflict',
    status: HttpStatus.CONFLICT,
    detail,
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
