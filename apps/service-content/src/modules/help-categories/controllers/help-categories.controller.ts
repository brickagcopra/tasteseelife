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
  CreateHelpCategoryRequestSchema,
  HelpCategoriesListResponseSchema,
  HelpCategoryResponseSchema,
  ListHelpCategoriesQuerySchema,
  UpdateHelpCategoryRequestSchema,
  type CreateHelpCategoryRequest,
  type HelpCategoriesListResponse,
  type HelpCategoryResponse,
  type ListHelpCategoriesQuery,
  type UpdateHelpCategoryRequest,
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
import { HelpCategoriesService } from '../services/help-categories.service';

/**
 * Help-center taxonomy CMS admin HTTP boundary (TS-284-followup-3; PRD §10.11;
 * PDD §19.3). A category has no version history / publish lifecycle, so the
 * surface is a plain create + PATCH + reads.
 *
 *   GET   /api/v1/admin/content/help-categories        — list (flat). `content:read`.
 *   POST  /api/v1/admin/content/help-categories        — create.      `content:edit`.
 *   GET   /api/v1/admin/content/help-categories/:id    — detail.      `content:read`.
 *   PATCH /api/v1/admin/content/help-categories/:id    — update.      `content:edit`.
 *
 * Authorisation, idempotency, and actor attribution mirror `PagesController`.
 */
@Controller()
export class HelpCategoriesController {
  constructor(private readonly categories: HelpCategoriesService) {}

  @Get('api/v1/admin/content/help-categories')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListHelpCategoriesQuerySchema))
    query: ListHelpCategoriesQuery,
  ): Promise<HelpCategoriesListResponse> {
    const categories = await this.categories.listCategories({
      parentId: query.parentId,
      limit: query.limit,
    });
    return HelpCategoriesListResponseSchema.parse({ categories: [...categories] });
  }

  @Post('api/v1/admin/content/help-categories')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateHelpCategoryRequestSchema))
    body: CreateHelpCategoryRequest,
    @Req() request: RequestWithContext,
  ): Promise<HelpCategoryResponse> {
    const ctx = requireContext(request);
    const outcome = await this.categories.createCategory({
      ...body,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      if (outcome.reason === 'parent_not_found') throw parentNotFound(body.parentId ?? '');
      throw conflict(`A help category with slug '${body.slug}' already exists.`);
    }
    return HelpCategoryResponseSchema.parse({ category: outcome.category });
  }

  @Get('api/v1/admin/content/help-categories/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('id') id: string): Promise<HelpCategoryResponse> {
    const outcome = await this.categories.getCategory(id);
    if (!outcome.ok) throw categoryNotFound(id);
    return HelpCategoryResponseSchema.parse({ category: outcome.category });
  }

  @Patch('api/v1/admin/content/help-categories/:id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('content:edit')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateHelpCategoryRequestSchema))
    body: UpdateHelpCategoryRequest,
    @Req() request: RequestWithContext,
  ): Promise<HelpCategoryResponse> {
    const ctx = requireContext(request);
    const outcome = await this.categories.updateCategory({
      ...body,
      categoryId: id,
      actorUserId: ctx.userId,
      audit: buildAuditActorContext(ctx, request),
    });
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'category_not_found':
          throw categoryNotFound(id);
        case 'parent_not_found':
          throw parentNotFound(body.parentId ?? '');
        case 'cycle':
          throw conflict(
            `Re-parenting category '${id}' under '${body.parentId ?? ''}' would create a cycle.`,
          );
      }
    }
    return HelpCategoryResponseSchema.parse({ category: outcome.category });
  }
}

function categoryNotFound(id: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No help category found for id '${id}'.`,
  });
}

function parentNotFound(parentId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No parent help category found for id '${parentId}'.`,
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
