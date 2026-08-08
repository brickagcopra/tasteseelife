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
  AcademyCohortResponseSchema,
  AcademyCohortsListResponseSchema,
  CreateAcademyCohortRequestSchema,
  ListAcademyCohortsQuerySchema,
  UpdateAcademyCohortRequestSchema,
  type AcademyCohortResponse,
  type AcademyCohortsListResponse,
  type CreateAcademyCohortRequest,
  type ListAcademyCohortsQuery,
  type UpdateAcademyCohortRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { CohortsService } from '../services/cohorts.service';

/**
 * Academy cohort admin HTTP boundary (TS-251; PRD §9.1, §9.5; PDD §15.1).
 *
 *   GET    /api/v1/admin/academy/courses/:courseId/cohorts — list (filtered). `academy:read`.
 *   POST   /api/v1/admin/academy/courses/:courseId/cohorts — schedule.        `academy:write`.
 *   PATCH  /api/v1/admin/academy/cohorts/:cohortId         — partial update.   `academy:write`.
 *   DELETE /api/v1/admin/academy/cohorts/:cohortId         — soft-delete.      `academy:write`.
 *
 * Same guard + idempotency posture as `CoursesController`. The create + list
 * surfaces are nested under their course (a missing course is a 404); the
 * update + delete surfaces address a cohort by its own id. A status change is
 * validated against the transition matrix; a terminal cohort rejects edits;
 * a non-monotonic merged start/end pair is a 409.
 */
@Controller()
export class CohortsController {
  constructor(private readonly cohorts: CohortsService) {}

  @Get('api/v1/admin/academy/courses/:courseId/cohorts')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async list(
    @Param('courseId') courseId: string,
    @Query(new ZodValidationPipe(ListAcademyCohortsQuerySchema))
    query: ListAcademyCohortsQuery,
  ): Promise<AcademyCohortsListResponse> {
    const outcome = await this.cohorts.listCohorts({
      courseId,
      status: query.status,
      includeDeleted: query.includeDeleted,
      limit: query.limit,
    });
    if (!outcome.ok) throw courseNotFound(courseId);
    return AcademyCohortsListResponseSchema.parse({ cohorts: [...outcome.cohorts] });
  }

  @Post('api/v1/admin/academy/courses/:courseId/cohorts')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async create(
    @Param('courseId') courseId: string,
    @Body(new ZodValidationPipe(CreateAcademyCohortRequestSchema))
    body: CreateAcademyCohortRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCohortResponse> {
    const ctx = requireContext(request);
    const outcome = await this.cohorts.createCohort({ ...body, courseId, actorUserId: ctx.userId });
    if (!outcome.ok) throw courseNotFound(courseId);
    return AcademyCohortResponseSchema.parse({ cohort: outcome.cohort });
  }

  @Patch('api/v1/admin/academy/cohorts/:cohortId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async update(
    @Param('cohortId') cohortId: string,
    @Body(new ZodValidationPipe(UpdateAcademyCohortRequestSchema))
    body: UpdateAcademyCohortRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCohortResponse> {
    const ctx = requireContext(request);
    const outcome = await this.cohorts.updateCohort({ ...body, cohortId, actorUserId: ctx.userId });
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw cohortNotFound(cohortId);
      if (outcome.reason === 'terminal') {
        throw conflict(`Cannot edit a cohort in the terminal '${outcome.status}' state.`);
      }
      if (outcome.reason === 'invalid_transition') {
        throw conflict(`Cannot transition a cohort from '${outcome.from}' to '${outcome.to}'.`);
      }
      throw conflict('endsAt must be after startsAt.');
    }
    return AcademyCohortResponseSchema.parse({ cohort: outcome.cohort });
  }

  @Delete('api/v1/admin/academy/cohorts/:cohortId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async remove(
    @Param('cohortId') cohortId: string,
    @Req() request: RequestWithContext,
  ): Promise<AcademyCohortResponse> {
    const ctx = requireContext(request);
    const outcome = await this.cohorts.softDeleteCohort(cohortId, ctx.userId);
    if (!outcome.ok) throw cohortNotFound(cohortId);
    return AcademyCohortResponseSchema.parse({ cohort: outcome.cohort });
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

function cohortNotFound(cohortId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy cohort found for id '${cohortId}'.`,
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
