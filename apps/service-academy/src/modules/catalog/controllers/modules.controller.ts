import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  AcademyModuleResponseSchema,
  AcademyModulesListResponseSchema,
  CreateAcademyModuleRequestSchema,
  DeleteAcademyModuleResponseSchema,
  UpdateAcademyModuleRequestSchema,
  type AcademyModuleResponse,
  type AcademyModulesListResponse,
  type CreateAcademyModuleRequest,
  type DeleteAcademyModuleResponse,
  type UpdateAcademyModuleRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { ModulesService } from '../services/modules.service';

/**
 * Academy course-module admin HTTP boundary (TS-251; PRD §9.1, §9.5; PDD
 * §15.1).
 *
 *   GET    /api/v1/admin/academy/courses/:courseId/modules — list (ordered). `academy:read`.
 *   POST   /api/v1/admin/academy/courses/:courseId/modules — create.         `academy:write`.
 *   PATCH  /api/v1/admin/academy/modules/:moduleId         — partial update.  `academy:write`.
 *   DELETE /api/v1/admin/academy/modules/:moduleId         — delete (cascade).`academy:write`.
 *
 * Same guard + idempotency posture as `CoursesController`. The create + list
 * surfaces are nested under their course (a missing course is a 404); the
 * update + delete surfaces address a module by its own id.
 */
@Controller()
export class ModulesController {
  constructor(private readonly modules: ModulesService) {}

  @Get('api/v1/admin/academy/courses/:courseId/modules')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(@Param('courseId') courseId: string): Promise<AcademyModulesListResponse> {
    const outcome = await this.modules.listModules(courseId);
    if (!outcome.ok) throw courseNotFound(courseId);
    return AcademyModulesListResponseSchema.parse({ modules: [...outcome.modules] });
  }

  @Post('api/v1/admin/academy/courses/:courseId/modules')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(CreateAcademyModuleRequestSchema))
    body: CreateAcademyModuleRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyModuleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.modules.createModule({ ...body, courseId, actorUserId: ctx.userId });
    if (!outcome.ok) throw courseNotFound(courseId);
    return AcademyModuleResponseSchema.parse({ module: outcome.module });
  }

  @Patch('api/v1/admin/academy/modules/:moduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(UpdateAcademyModuleRequestSchema))
    body: UpdateAcademyModuleRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyModuleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.modules.updateModule({ ...body, moduleId, actorUserId: ctx.userId });
    if (!outcome.ok) throw moduleNotFound(moduleId);
    return AcademyModuleResponseSchema.parse({ module: outcome.module });
  }

  @Delete('api/v1/admin/academy/modules/:moduleId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async remove(
    @Param('moduleId') moduleId: string,
    @Req() request: RequestWithContext,
  ): Promise<DeleteAcademyModuleResponse> {
    const ctx = requireContext(request);
    const outcome = await this.modules.deleteModule(moduleId, ctx.userId);
    if (!outcome.ok) throw moduleNotFound(moduleId);
    return DeleteAcademyModuleResponseSchema.parse({
      deletedModuleId: outcome.deletedModuleId,
      deletedLessonCount: outcome.deletedLessonCount,
    });
  }
}

function courseNotFound(courseId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy course found for id '${courseId}'.`,
  });
}

function moduleNotFound(moduleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy module found for id '${moduleId}'.`,
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
