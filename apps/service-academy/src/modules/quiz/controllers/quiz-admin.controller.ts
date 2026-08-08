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
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  AcademyQuizAuthoringResponseSchema,
  AcademyQuizQuestionResponseSchema,
  AcademyQuizResponseSchema,
  CreateAcademyQuizQuestionRequestSchema,
  CreateAcademyQuizRequestSchema,
  UpdateAcademyQuizQuestionRequestSchema,
  UpdateAcademyQuizRequestSchema,
  type AcademyQuizAuthoringResponse,
  type AcademyQuizQuestionResponse,
  type AcademyQuizResponse,
  type CreateAcademyQuizQuestionRequest,
  type CreateAcademyQuizRequest,
  type UpdateAcademyQuizQuestionRequest,
  type UpdateAcademyQuizRequest,
} from '@taste-and-see/contracts';
import {
  AccessTokenGuard,
  PermissionGuard,
  RequirePermissions,
  type RequestWithContext,
} from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { QuizAuthoringService } from '../services/quiz-authoring.service';

/**
 * Academy quiz-authoring admin HTTP boundary (TS-254; PRD §9.2–§9.3; PDD §15.1).
 *
 *   POST   /api/v1/admin/academy/lessons/:lessonId/quiz — create the lesson's quiz. `academy:write`.
 *   GET    /api/v1/admin/academy/lessons/:lessonId/quiz — authoring tree.          `academy:read`.
 *   PATCH  /api/v1/admin/academy/quizzes/:quizId        — update quiz config.       `academy:write`.
 *   DELETE /api/v1/admin/academy/quizzes/:quizId        — delete quiz (204).        `academy:write`.
 *   POST   /api/v1/admin/academy/quizzes/:quizId/questions — append a question.     `academy:write`.
 *   PATCH  /api/v1/admin/academy/questions/:questionId  — update a question.        `academy:write`.
 *   DELETE /api/v1/admin/academy/questions/:questionId  — soft-delete (204).        `academy:write`.
 *
 * Same guard + idempotency posture as the catalog controllers. The quiz bank is
 * platform-wide catalog content (no tenant axis; `unscopedModels`).
 */
@Controller()
export class QuizAdminController {
  constructor(private readonly authoring: QuizAuthoringService) {}

  @Post('api/v1/admin/academy/lessons/:lessonId/quiz')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async createQuiz(
    @Param('lessonId') lessonId: string,
    @Body(new ZodValidationPipe(CreateAcademyQuizRequestSchema)) body: CreateAcademyQuizRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizResponse> {
    const ctx = requireContext(request);
    const outcome = await this.authoring.createQuiz({ ...body, lessonId, actorUserId: ctx.userId });
    if (!outcome.ok) {
      if (outcome.reason === 'lesson_not_found') throw lessonNotFound(lessonId);
      if (outcome.reason === 'lesson_not_quiz') {
        throw new ConflictException(problem(`Lesson '${lessonId}' is not a quiz lesson.`));
      }
      throw new ConflictException(problem(`Lesson '${lessonId}' already has a quiz.`));
    }
    return AcademyQuizResponseSchema.parse({ quiz: outcome.quiz });
  }

  @Get('api/v1/admin/academy/lessons/:lessonId/quiz')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:read')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  async getQuiz(@Param('lessonId') lessonId: string): Promise<AcademyQuizAuthoringResponse> {
    const outcome = await this.authoring.getAuthoringTree(lessonId);
    if (!outcome.ok) throw quizNotFoundForLesson(lessonId);
    return AcademyQuizAuthoringResponseSchema.parse({ quiz: outcome.quiz });
  }

  @Patch('api/v1/admin/academy/quizzes/:quizId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async updateQuiz(
    @Param('quizId') quizId: string,
    @Body(new ZodValidationPipe(UpdateAcademyQuizRequestSchema)) body: UpdateAcademyQuizRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizResponse> {
    const ctx = requireContext(request);
    const outcome = await this.authoring.updateQuiz({ ...body, quizId, actorUserId: ctx.userId });
    if (!outcome.ok) throw quizNotFound(quizId);
    return AcademyQuizResponseSchema.parse({ quiz: outcome.quiz });
  }

  @Delete('api/v1/admin/academy/quizzes/:quizId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async removeQuiz(
    @Param('quizId') quizId: string,
    @Req() request: RequestWithContext,
  ): Promise<void> {
    const ctx = requireContext(request);
    const outcome = await this.authoring.deleteQuiz(quizId, ctx.userId);
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw quizNotFound(quizId);
      throw new ConflictException(
        problem(`Quiz '${quizId}' has attempts and cannot be deleted; archive its lesson instead.`),
      );
    }
  }

  @Post('api/v1/admin/academy/quizzes/:quizId/questions')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async createQuestion(
    @Param('quizId') quizId: string,
    @Body(new ZodValidationPipe(CreateAcademyQuizQuestionRequestSchema))
    body: CreateAcademyQuizQuestionRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizQuestionResponse> {
    const ctx = requireContext(request);
    const outcome = await this.authoring.createQuestion({
      ...body,
      quizId,
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) throw quizNotFound(quizId);
    return AcademyQuizQuestionResponseSchema.parse({ question: outcome.question });
  }

  @Patch('api/v1/admin/academy/questions/:questionId')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async updateQuestion(
    @Param('questionId') questionId: string,
    @Body(new ZodValidationPipe(UpdateAcademyQuizQuestionRequestSchema))
    body: UpdateAcademyQuizQuestionRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizQuestionResponse> {
    const ctx = requireContext(request);
    const outcome = await this.authoring.updateQuestion({
      ...body,
      questionId,
      actorUserId: ctx.userId,
    });
    if (!outcome.ok) throw questionNotFound(questionId);
    return AcademyQuizQuestionResponseSchema.parse({ question: outcome.question });
  }

  @Delete('api/v1/admin/academy/questions/:questionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('academy:write')
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @Idempotent()
  async removeQuestion(
    @Param('questionId') questionId: string,
    @Req() request: RequestWithContext,
  ): Promise<void> {
    const ctx = requireContext(request);
    const outcome = await this.authoring.softDeleteQuestion(questionId, ctx.userId);
    if (!outcome.ok) throw questionNotFound(questionId);
  }
}

function problem(detail: string): {
  type: string;
  title: string;
  status: number;
  detail: string;
} {
  return { type: 'about:blank', title: 'Conflict', status: HttpStatus.CONFLICT, detail };
}

function lessonNotFound(lessonId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy lesson found for id '${lessonId}'.`,
  });
}

function quizNotFoundForLesson(lessonId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No quiz found for academy lesson '${lessonId}'.`,
  });
}

function quizNotFound(quizId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy quiz found for id '${quizId}'.`,
  });
}

function questionNotFound(questionId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy quiz question found for id '${questionId}'.`,
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
