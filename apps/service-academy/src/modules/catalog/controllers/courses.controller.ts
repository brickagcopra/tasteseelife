import {
  Body,
  ConflictException,
  Controller,
  Delete,
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
  AcademyCourseDetailResponseSchema,
  AcademyCourseResponseSchema,
  AcademyCoursesListResponseSchema,
  CreateAcademyCourseRequestSchema,
  ListAcademyCoursesQuerySchema,
  UpdateAcademyCourseRequestSchema,
  type AcademyCourseDetailResponse,
  type AcademyCourseResponse,
  type AcademyCoursesListResponse,
  type CreateAcademyCourseRequest,
  type ListAcademyCoursesQuery,
  type UpdateAcademyCourseRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { CoursesService } from '../services/courses.service';

/**
 * Academy course-catalog admin HTTP boundary (TS-251; PRD §9.1, §9.5; PDD
 * §15.1).
 *
 *   GET    /api/v1/admin/academy/courses            — list (filtered). `academy:read`.
 *   POST   /api/v1/admin/academy/courses            — create.            `academy:write`.
 *   GET    /api/v1/admin/academy/courses/:courseId  — detail (tree).     `academy:read`.
 *   PATCH  /api/v1/admin/academy/courses/:courseId  — partial update.    `academy:write`.
 *   DELETE /api/v1/admin/academy/courses/:courseId  — soft-delete.       `academy:write`.
 *
 * **Authorisation.** Every endpoint sits behind `AccessTokenGuard` (verify the
 * JWT + attach the RequestContext) followed by `PermissionGuard`, which reads
 * the `@RequirePermissions(...)` metadata (CLAUDE.md §3.2). The gateway BFF
 * enforces the same gate at the edge (defence-in-depth).
 *
 * **Idempotency.** The write endpoints wear `@Idempotent()` so a retried
 * request with the same `Idempotency-Key` returns the cached response rather
 * than re-applying the mutation (CLAUDE.md §3.3 / §17.5).
 *
 * **Actor attribution.** The acting admin's id is the authoritative `userId`
 * from the verified token — never read from the body — so the structured logs
 * capture who did what.
 */
@Controller()
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get('api/v1/admin/academy/courses')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Query(new ZodValidationPipe(ListAcademyCoursesQuerySchema))
    query: ListAcademyCoursesQuery,
  ): Promise<AcademyCoursesListResponse> {
    const courses = await this.courses.listCourses({
      status: query.status,
      track: query.track,
      kind: query.kind,
      includeDeleted: query.includeDeleted,
      limit: query.limit,
    });
    return AcademyCoursesListResponseSchema.parse({ courses: [...courses] });
  }

  @Post('api/v1/admin/academy/courses')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Body(new ZodValidationPipe(CreateAcademyCourseRequestSchema))
    body: CreateAcademyCourseRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCourseResponse> {
    const ctx = requireContext(request);
    const outcome = await this.courses.createCourse({ ...body, actorUserId: ctx.userId });
    if (!outcome.ok) {
      throw conflict(`A course with slug '${body.slug}' already exists.`);
    }
    return AcademyCourseResponseSchema.parse({ course: outcome.course });
  }

  @Get('api/v1/admin/academy/courses/:courseId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async detail(@Param('courseId') courseId: string): Promise<AcademyCourseDetailResponse> {
    const outcome = await this.courses.getCourseDetail(courseId);
    if (!outcome.ok) throw courseNotFound(courseId);
    return AcademyCourseDetailResponseSchema.parse({ course: outcome.course });
  }

  @Patch('api/v1/admin/academy/courses/:courseId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(UpdateAcademyCourseRequestSchema))
    body: UpdateAcademyCourseRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCourseResponse> {
    const ctx = requireContext(request);
    const outcome = await this.courses.updateCourse({ ...body, courseId, actorUserId: ctx.userId });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw courseNotFound(courseId);
      if (outcome.reason === 'slug_conflict') {
        throw conflict(`A course with slug '${body.slug ?? ''}' already exists.`);
      }
      throw conflict(`Cannot transition a course from '${outcome.from}' to '${outcome.to}'.`);
    }
    return AcademyCourseResponseSchema.parse({ course: outcome.course });
  }

  @Delete('api/v1/admin/academy/courses/:courseId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async remove(
    @Param('courseId') courseId: string,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCourseResponse> {
    const ctx = requireContext(request);
    const outcome = await this.courses.softDeleteCourse(courseId, ctx.userId);
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw courseNotFound(courseId);
      throw conflict('Cannot delete a course that still has cohorts. Archive the course instead.');
    }
    return AcademyCourseResponseSchema.parse({ course: outcome.course });
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
