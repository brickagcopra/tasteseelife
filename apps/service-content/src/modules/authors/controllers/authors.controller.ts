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
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  ArticleAuthorsResponseSchema,
  ContentAuthorResponseSchema,
  ContentAuthorsListResponseSchema,
  CreateContentAuthorRequestSchema,
  ListContentAuthorsQuerySchema,
  SetArticleAuthorsRequestSchema,
  UpdateContentAuthorRequestSchema,
  type ArticleAuthorsResponse,
  type ContentAuthorResponse,
  type ContentAuthorsListResponse,
  type CreateContentAuthorRequest,
  type ListContentAuthorsQuery,
  type SetArticleAuthorsRequest,
  type UpdateContentAuthorRequest,
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
import { AuthorsService } from '../services/authors.service';

/**
 * Author profiles + article byline CMS admin HTTP boundary (TS-283; PRD §10.10;
 * PDD §19.1).
 *
 *   GET   /api/v1/admin/content/authors                       — list.   `content:read`.
 *   POST  /api/v1/admin/content/authors                       — create. `content:edit`.
 *   GET   /api/v1/admin/content/authors/:authorId             — detail. `content:read`.
 *   PATCH /api/v1/admin/content/authors/:authorId             — update. `content:edit`.
 *   GET   /api/v1/admin/content/articles/:articleId/authors   — byline read. `content:read`.
 *   PUT   /api/v1/admin/content/articles/:articleId/authors   — set byline.  `content:edit`.
 *
 * The article-authors sub-resource is served here (not embedded in the article
 * detail) so the TS-284 `ArticleDetail` shape is untouched. Authorisation,
 * idempotency, and actor attribution mirror `ArticlesController`; the acting
 * staff id is the verified token's `userId`, never the body.
 */
@Controller()
export class AuthorsController {
  constructor(private readonly authors: AuthorsService) {}

  @Get('api/v1/admin/content/authors')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListContentAuthorsQuerySchema))
    query: ListContentAuthorsQuery,
  ): Promise<ContentAuthorsListResponse> {
    const authors = await this.authors.listAuthors(query.limit);
    return ContentAuthorsListResponseSchema.parse({ authors: [...authors] });
  }

  @Post('api/v1/admin/content/authors')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateContentAuthorRequestSchema))
    body: CreateContentAuthorRequest,
    @Req() request: RequestWithContext,
  ): Promise<ContentAuthorResponse> {
    const ctx = requireContext(request);
    const outcome = await this.authors.createAuthor({
      ...body,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      throw conflict(`An author profile for user '${body.userId}' already exists.`);
    }
    return ContentAuthorResponseSchema.parse({ author: outcome.author });
  }

  @Get('api/v1/admin/content/authors/:authorId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('authorId') authorId: string): Promise<ContentAuthorResponse> {
    const outcome = await this.authors.getAuthor(authorId);
    if (!outcome.ok) throw authorNotFound(authorId);
    return ContentAuthorResponseSchema.parse({ author: outcome.author });
  }

  @Patch('api/v1/admin/content/authors/:authorId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('authorId') authorId: string,
    @Body(new ZodValidationPipe(UpdateContentAuthorRequestSchema))
    body: UpdateContentAuthorRequest,
    @Req() request: RequestWithContext,
  ): Promise<ContentAuthorResponse> {
    const ctx = requireContext(request);
    const outcome = await this.authors.updateAuthor({
      ...body,
      authorId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) throw authorNotFound(authorId);
    return ContentAuthorResponseSchema.parse({ author: outcome.author });
  }

  @Get('api/v1/admin/content/articles/:articleId/authors')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async listArticleAuthors(@Param('articleId') articleId: string): Promise<ArticleAuthorsResponse> {
    const outcome = await this.authors.getArticleAuthors(articleId);
    if (!outcome.ok) throw articleNotFound(articleId);
    return ArticleAuthorsResponseSchema.parse({ authors: [...outcome.authors] });
  }

  @Put('api/v1/admin/content/articles/:articleId/authors')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async setArticleAuthors(
    @Param('articleId') articleId: string,
    @Body(new ZodValidationPipe(SetArticleAuthorsRequestSchema))
    body: SetArticleAuthorsRequest,
    @Req() request: RequestWithContext,
  ): Promise<ArticleAuthorsResponse> {
    const ctx = requireContext(request);
    const outcome = await this.authors.setArticleAuthors({
      articleId,
      authors: body.authors,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'author_not_found') {
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: HttpStatus.NOT_FOUND,
          detail: 'One or more author ids do not resolve to an existing author.',
        });
      }
      throw articleNotFound(articleId);
    }
    return ArticleAuthorsResponseSchema.parse({ authors: [...outcome.authors] });
  }
}

function authorNotFound(authorId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No content author found for id '${authorId}'.`,
  });
}

function articleNotFound(articleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No content article found for id '${articleId}'.`,
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
