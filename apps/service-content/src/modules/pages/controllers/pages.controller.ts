import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  CreatePageRequestSchema,
  CreatePageVersionRequestSchema,
  ListPagesQuerySchema,
  PageDetailResponseSchema,
  PageResponseSchema,
  PageVersionResponseSchema,
  PagesListResponseSchema,
  PublishPageVersionRequestSchema,
  type CreatePageRequest,
  type CreatePageVersionRequest,
  type ListPagesQuery,
  type PageDetailResponse,
  type PageResponse,
  type PageVersionResponse,
  type PagesListResponse,
  type PublishPageVersionRequest,
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
import { PagesService } from '../services/pages.service';

/**
 * Static-pages CMS admin HTTP boundary (TS-284; PRD §10.11; PDD §19.2).
 *
 *   GET  /api/v1/admin/content/pages                                 — list.     `content:read`.
 *   POST /api/v1/admin/content/pages                                 — create.   `content:edit`.
 *   GET  /api/v1/admin/content/pages/:pageId                         — detail.   `content:read`.
 *   POST /api/v1/admin/content/pages/:pageId/versions               — append.   `content:edit`.
 *   GET  /api/v1/admin/content/pages/:pageId/versions/:versionId    — version.  `content:read`.
 *   POST /api/v1/admin/content/pages/:pageId/versions/:versionId/publish — publish. `content:publish`.
 *
 * **Authorisation.** Every endpoint sits behind `AccessTokenGuard` (verify the
 * JWT + attach the RequestContext) followed by `PermissionGuard`, which reads
 * the `@RequirePermissions(...)` metadata (CLAUDE.md §3.2). Authoring is gated
 * on `content:edit`; the compliance-sensitive `publish` lever on the
 * higher-trust `content:publish`; reads on `content:read` (PDD Appendix B).
 *
 * **Idempotency.** The write endpoints wear `@Idempotent()` so a retried request
 * with the same `Idempotency-Key` returns the cached response (CLAUDE.md §3.3).
 *
 * **Actor attribution.** The acting staff id is the authoritative `userId` from
 * the verified token — never read from the body; it is also the version's
 * `createdBy`.
 */
@Controller()
export class PagesController {
  constructor(private readonly pages: PagesService) {}

  @Get('api/v1/admin/content/pages')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListPagesQuerySchema))
    query: ListPagesQuery,
  ): Promise<PagesListResponse> {
    const pages = await this.pages.listPages({ status: query.status, limit: query.limit });
    return PagesListResponseSchema.parse({ pages: [...pages] });
  }

  @Post('api/v1/admin/content/pages')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreatePageRequestSchema))
    body: CreatePageRequest,
    @Req() request: RequestWithContext,
  ): Promise<PageResponse> {
    const ctx = requireContext(request);
    const outcome = await this.pages.createPage({
      ...body,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      throw conflict(`A page with slug '${body.slug}' already exists.`);
    }
    return PageResponseSchema.parse({ page: outcome.page });
  }

  @Get('api/v1/admin/content/pages/:pageId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('pageId') pageId: string): Promise<PageDetailResponse> {
    const outcome = await this.pages.getPageDetail(pageId);
    if (!outcome.ok) throw pageNotFound(pageId);
    return PageDetailResponseSchema.parse({ page: outcome.page });
  }

  @Post('api/v1/admin/content/pages/:pageId/versions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async appendVersion(
    @Param('pageId') pageId: string,
    @Body(new ZodValidationPipe(CreatePageVersionRequestSchema))
    body: CreatePageVersionRequest,
    @Req() request: RequestWithContext,
  ): Promise<PageVersionResponse> {
    const ctx = requireContext(request);
    const outcome = await this.pages.appendVersion({
      ...body,
      pageId,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) throw pageNotFound(pageId);
    return PageVersionResponseSchema.parse({ version: outcome.version });
  }

  @Get('api/v1/admin/content/pages/:pageId/versions/:versionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async version(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ): Promise<PageVersionResponse> {
    const outcome = await this.pages.getVersion(pageId, versionId);
    if (!outcome.ok) throw versionNotFound(pageId, versionId);
    return PageVersionResponseSchema.parse({ version: outcome.version });
  }

  @Post('api/v1/admin/content/pages/:pageId/versions/:versionId/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:publish')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async publish(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
    @Body(new ZodValidationPipe(PublishPageVersionRequestSchema))
    body: PublishPageVersionRequest,
    @Req() request: RequestWithContext,
  ): Promise<PageResponse> {
    const ctx = requireContext(request);
    const outcome = await this.pages.publishVersion({
      pageId,
      versionId,
      effectiveAt: body.effectiveAt,
      isMaterialChange: body.isMaterialChange,
      materialChangeNote: body.materialChangeNote,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'page_not_found':
          throw pageNotFound(pageId);
        case 'version_not_found':
          throw versionNotFound(pageId, versionId);
        case 'page_archived':
          throw conflict(`Page '${pageId}' is archived and cannot be published.`);
      }
    }
    return PageResponseSchema.parse({ page: outcome.page });
  }
}

function pageNotFound(pageId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No content page found for id '${pageId}'.`,
  });
}

function versionNotFound(pageId: string, versionId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No version '${versionId}' found on page '${pageId}'.`,
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
