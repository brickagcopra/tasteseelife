import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  AcademyQuizAttemptDetailResponseSchema,
  AcademyQuizAttemptsListResponseSchema,
  SubmitQuizAttemptRequestSchema,
  type AcademyQuizAttemptDetailResponse,
  type AcademyQuizAttemptsListResponse,
  type SubmitQuizAttemptRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { QuizAttemptService } from '../services/quiz-attempt.service';

/**
 * Academy quiz-attempt student HTTP boundary (TS-254; PRD §9.2–§9.3; PDD §15.1).
 *
 *   POST /api/v1/academy/quizzes/:quizId/attempts      — start an attempt (201).
 *   POST /api/v1/academy/attempts/:attemptId/submit    — submit + grade (200).
 *   GET  /api/v1/academy/attempts/:attemptId           — read one own attempt.
 *   GET  /api/v1/academy/quizzes/:quizId/attempts       — list own attempts.
 *
 * Behind `AccessTokenGuard` only (any authenticated student) — NOT the
 * `academy:*` admin permissions. The attempt rows are tenant-scoped: the service
 * filters every read/write by the authenticated `studentUserId`, so a foreign
 * attempt id resolves to 404 (the `TenantContextInterceptor` seeds the scoped
 * frame from the access token; CLAUDE.md §3.2). Mutations honour `Idempotency-Key`.
 */
@Controller()
export class QuizAttemptController {
  constructor(private readonly attempts: QuizAttemptService) {}

  @Post('api/v1/academy/quizzes/:quizId/attempts')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async start(
    @Param('quizId') quizId: string,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizAttemptDetailResponse> {
    const ctx = requireContext(request);
    const outcome = await this.attempts.startAttempt(quizId, ctx.userId);
    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'quiz_not_found':
          throw quizNotFound(quizId);
        case 'insufficient_questions':
          throw new ConflictException(
            conflict(`Quiz '${quizId}' does not have enough questions to start an attempt.`),
          );
        case 'attempt_in_progress':
          throw new ConflictException(
            conflict('You already have an attempt in progress for this quiz; submit it first.'),
          );
        case 'max_attempts_reached':
          throw new ConflictException(
            conflict('You have reached the attempt limit for this quiz.'),
          );
        case 'cooldown_active':
          throw tooManyRequests(
            `Retake cooldown is active; try again after ${outcome.retryAfter.toISOString()}.`,
            outcome.retryAfter,
          );
      }
    }
    return AcademyQuizAttemptDetailResponseSchema.parse({ detail: outcome.detail });
  }

  @Post('api/v1/academy/attempts/:attemptId/submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async submit(
    @Param('attemptId') attemptId: string,
    @Body(new ZodValidationPipe(SubmitQuizAttemptRequestSchema)) body: SubmitQuizAttemptRequest,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizAttemptDetailResponse> {
    const ctx = requireContext(request);
    const outcome = await this.attempts.submitAttempt(attemptId, ctx.userId, body.answers);
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') throw attemptNotFound(attemptId);
      if (outcome.reason === 'already_submitted') {
        throw new ConflictException(conflict(`Attempt '${attemptId}' has already been submitted.`));
      }
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: `Question '${outcome.questionId}' is not part of this attempt.`,
      });
    }
    return AcademyQuizAttemptDetailResponseSchema.parse({ detail: outcome.detail });
  }

  @Get('api/v1/academy/attempts/:attemptId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async get(
    @Param('attemptId') attemptId: string,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizAttemptDetailResponse> {
    const ctx = requireContext(request);
    const outcome = await this.attempts.getAttempt(attemptId, ctx.userId);
    if (!outcome.ok) throw attemptNotFound(attemptId);
    return AcademyQuizAttemptDetailResponseSchema.parse({ detail: outcome.detail });
  }

  @Get('api/v1/academy/quizzes/:quizId/attempts')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async list(
    @Param('quizId') quizId: string,
    @Req() request: RequestWithContext,
  ): Promise<AcademyQuizAttemptsListResponse> {
    const ctx = requireContext(request);
    const attempts = await this.attempts.listAttempts(quizId, ctx.userId);
    return AcademyQuizAttemptsListResponseSchema.parse({ attempts: [...attempts] });
  }
}

function conflict(detail: string): { type: string; title: string; status: number; detail: string } {
  return { type: 'about:blank', title: 'Conflict', status: HttpStatus.CONFLICT, detail };
}

function tooManyRequests(detail: string, retryAfter: Date): HttpException {
  return new HttpException(
    {
      type: 'about:blank',
      title: 'Too Many Requests',
      status: HttpStatus.TOO_MANY_REQUESTS,
      detail,
      retryAfter: retryAfter.toISOString(),
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function quizNotFound(quizId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy quiz found for id '${quizId}'.`,
  });
}

function attemptNotFound(attemptId: string): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: HttpStatus.NOT_FOUND,
    detail: `No academy quiz attempt found for id '${attemptId}'.`,
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
