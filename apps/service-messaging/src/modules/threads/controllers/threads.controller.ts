import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
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
  UsePipes,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  AddThreadParticipantRequestSchema,
  AddThreadParticipantResponseSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  ListThreadsInboxQuerySchema,
  RemoveThreadParticipantResponseSchema,
  THREAD_ID_MAX_LENGTH,
  THREAD_USER_ID_MAX_LENGTH,
  ThreadDetailResponseSchema,
  ThreadsInboxResponseSchema,
  type AddThreadParticipantRequest,
  type AddThreadParticipantResponse,
  type CreateThreadRequest,
  type CreateThreadResponse,
  type ListThreadsInboxQuery,
  type RemoveThreadParticipantResponse,
  type ThreadDetailResponse,
  type ThreadsInboxResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import { z } from 'zod';

import type { RosterGateFailure } from '../services/threads.service';
import { ThreadsService } from '../services/threads.service';

/** Path-param validators — bound the ids so a malformed value can't dodge the index lookup. */
const ThreadIdParamSchema = z.string().min(1).max(THREAD_ID_MAX_LENGTH);
const UserIdParamSchema = z.string().min(1).max(THREAD_USER_ID_MAX_LENGTH);

/**
 * Thread + thread-participant CRUD HTTP boundary (TS-070-followup-2; PRD §6.7;
 * PDD §8.2 + §13.1).
 *
 * All surfaces sit behind `AccessTokenGuard`; the row-level trust gate is the
 * caller's own `thread_participants` membership (CLAUDE.md §3.2 — a
 * non-participant sees a thread as if it does not exist). The mutating
 * surfaces wear `@Idempotent()` so a retried request with the same
 * `Idempotency-Key` returns the cached response (CLAUDE.md §3.3 / §17.5).
 *
 *   POST   /api/v1/threads
 *     Create a thread, seeding the supplied participants. The authenticated
 *     creator (`ctx.userId`) is added implicitly as a `member` so they can
 *     immediately read what they created.
 *
 *   GET    /api/v1/threads/me
 *     The caller's inbox — every thread they participate in, newest membership
 *     first, each carrying the caller's role + read cursor + a participant
 *     count. Archived threads excluded unless `?includeArchived=true`.
 *
 *   GET    /api/v1/threads/:threadId
 *     Thread detail with the participant list. 404 when the thread does not
 *     exist OR the caller is not a participant (no existence leak).
 *
 *   POST   /api/v1/threads/:threadId/participants
 *     Add a participant. Requires a posting role on a non-archived thread.
 *     Idempotent on the roster.
 *
 *   DELETE /api/v1/threads/:threadId/participants/:userId
 *     Remove a participant. Any participant may remove themselves (leave);
 *     removing someone else requires a posting role on a non-archived thread.
 *     Idempotent.
 *
 * Threads are also auto-provisioned from cross-service events (booking.created
 * / household.created) — that path is the sibling TS-070-followup-3 and uses
 * `ThreadsService` directly rather than this user-facing surface.
 */
@Controller()
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Post('api/v1/threads')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(CreateThreadRequestSchema))
  @Idempotent()
  async create(
    @Body() body: CreateThreadRequest,
    @Req() request: RequestWithContext,
  ): Promise<CreateThreadResponse> {
    const ctx = requireContext(request);

    const thread = await this.threads.createThread({
      kind: body.kind,
      householdId: body.householdId ?? null,
      bookingId: body.bookingId ?? null,
      participants: body.participants,
      // The authenticated creator is guaranteed a membership so they can read
      // the thread they just created (the trust gate is participation).
      ensureMemberUserId: ctx.userId,
    });

    const response: CreateThreadResponse = { thread };
    // Defence-in-depth: validate the response shape at the boundary so a
    // future drift between the service projection + contract surfaces here
    // rather than at the consumer.
    return CreateThreadResponseSchema.parse(response);
  }

  @Get('api/v1/threads/me')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async listMine(
    @Query(new ZodValidationPipe(ListThreadsInboxQuerySchema))
    query: ListThreadsInboxQuery,
    @Req() request: RequestWithContext,
  ): Promise<ThreadsInboxResponse> {
    const ctx = requireContext(request);

    const threads = await this.threads.listInbox({
      userId: ctx.userId,
      limit: query.limit,
      includeArchived: query.includeArchived ?? false,
    });

    const response: ThreadsInboxResponse = { threads: [...threads] };
    return ThreadsInboxResponseSchema.parse(response);
  }

  @Get('api/v1/threads/:threadId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async detail(
    @Param('threadId', new ZodValidationPipe(ThreadIdParamSchema)) threadId: string,
    @Req() request: RequestWithContext,
  ): Promise<ThreadDetailResponse> {
    const ctx = requireContext(request);

    const thread = await this.threads.getThreadDetailForMember(threadId, ctx.userId);
    if (thread === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Thread not found.',
      });
    }

    const response: ThreadDetailResponse = { thread };
    return ThreadDetailResponseSchema.parse(response);
  }

  @Post('api/v1/threads/:threadId/participants')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async addParticipant(
    @Param('threadId', new ZodValidationPipe(ThreadIdParamSchema)) threadId: string,
    @Body(new ZodValidationPipe(AddThreadParticipantRequestSchema))
    body: AddThreadParticipantRequest,
    @Req() request: RequestWithContext,
  ): Promise<AddThreadParticipantResponse> {
    const ctx = requireContext(request);

    const result = await this.threads.addParticipant({
      threadId,
      requesterUserId: ctx.userId,
      userId: body.userId,
      role: body.role,
    });
    if (!result.ok) throw rosterGateException(result.error);

    return AddThreadParticipantResponseSchema.parse(result.value);
  }

  @Delete('api/v1/threads/:threadId/participants/:userId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async removeParticipant(
    @Param('threadId', new ZodValidationPipe(ThreadIdParamSchema)) threadId: string,
    @Param('userId', new ZodValidationPipe(UserIdParamSchema)) userId: string,
    @Req() request: RequestWithContext,
  ): Promise<RemoveThreadParticipantResponse> {
    const ctx = requireContext(request);

    const result = await this.threads.removeParticipant({
      threadId,
      requesterUserId: ctx.userId,
      userId,
    });
    if (!result.ok) throw rosterGateException(result.error);

    return RemoveThreadParticipantResponseSchema.parse(result.value);
  }
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

/**
 * Map a roster-mutation gate failure to its RFC 7807 HTTP exception:
 *   - `not_a_participant` → 404 (no thread-existence leak).
 *   - `thread_archived`   → 409 (a closed conversation's roster is frozen).
 *   - `forbidden_role`    → 403 (a read-only observer cannot manage others).
 */
function rosterGateException(
  failure: RosterGateFailure,
): NotFoundException | ConflictException | ForbiddenException {
  switch (failure.reason) {
    case 'not_a_participant':
      return new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Thread not found.',
      });
    case 'thread_archived':
      return new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'This thread is archived; its participants cannot be changed.',
      });
    case 'forbidden_role':
      return new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have permission to change this thread’s participants.',
      });
  }
}
