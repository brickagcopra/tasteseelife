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
  AcademyLessonResponseSchema,
  AcademyLessonsListResponseSchema,
  CreateAcademyLessonRequestSchema,
  UpdateAcademyLessonRequestSchema,
  type AcademyLessonResponse,
  type AcademyLessonsListResponse,
  type CreateAcademyLessonRequest,
  type UpdateAcademyLessonRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { LessonsService } from '../services/lessons.service';

/**
 * Academy lesson admin HTTP boundary (TS-251; PRD §9.2, §9.5; PDD §15.1).
 *
 *   GET    /api/v1/admin/academy/modules/:moduleId/lessons — list (ordered). `academy:read`.
 *   POST   /api/v1/admin/academy/modules/:moduleId/lessons — create.         `academy:write`.
 *   PATCH  /api/v1/admin/academy/lessons/:lessonId         — partial update.  `academy:write`.
 *   DELETE /api/v1/admin/academy/lessons/:lessonId         — delete (204).    `academy:write`.
 *
 * Same guard + idempotency posture as `CoursesController`. The create + list
 * surfaces are nested under their module (a missing module is a 404); the
 * update + delete surfaces address a lesson by its own id.
 */
@Controller()
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}

  @Get('api/v1/admin/academy/modules/:moduleId/lessons')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(@Param('moduleId') moduleId: string): Promise<AcademyLessonsListResponse> {
    const outcome = await this.lessons.listLessons(moduleId);
    if (!outcome.ok) throw moduleNotFound(moduleId);
    return AcademyLessonsListResponseSchema.parse({ lessons: [...outcome.lessons] });
  }

  @Post('api/v1/admin/academy/modules/:moduleId/lessons')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Param('moduleId') moduleId: string,
    @Body(new ZodValidationPipe(CreateAcademyLessonRequestSchema))
    body: CreateAcademyLessonRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyLessonResponse> {
    const ctx = requireContext(request);
    const outcome = await this.lessons.createLesson({ ...body, moduleId, actorUserId: ctx.userId });
    if (!outcome.ok) throw moduleNotFound(moduleId);
    return AcademyLessonResponseSchema.parse({ lesson: outcome.lesson });
  }

  @Patch('api/v1/admin/academy/lessons/:lessonId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(UpdateAcademyLessonRequestSchema))
    body: UpdateAcademyLessonRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyLessonResponse> {
    const ctx = requireContext(request);
    const outcome = await this.lessons.updateLesson({ ...body, lessonId, actorUserId: ctx.userId });
    if (!outcome.ok) throw lessonNotFound(lessonId);
    return AcademyLessonResponseSchema.parse({ lesson: outcome.lesson });
  }

  @Delete('api/v1/admin/academy/lessons/:lessonId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async remove(
    @Param('lessonId') lessonId: string,
    @Req() request: RequestWithContext,
  ): Promise<void> {
    const ctx = requireContext(request);
    const outcome = await this.lessons.deleteLesson(lessonId, ctx.userId);
    if (!outcome.ok) throw lessonNotFound(lessonId);
  }
}

function moduleNotFound(moduleId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy module found for id '${moduleId}'.`,
  });
}

function lessonNotFound(lessonId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy lesson found for id '${lessonId}'.`,
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
