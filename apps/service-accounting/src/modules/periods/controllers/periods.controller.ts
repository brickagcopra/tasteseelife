import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { Idempotent } from '@taste-and-see/nest-idempotency';
import {
  ClosePeriodRequestSchema,
  GENERATE_PERIODS_MAX_COUNT,
  GeneratePeriodsRequestSchema,
  LIST_PERIODS_LIMIT_DEFAULT,
  ListPeriodsQuerySchema,
  PeriodNameSchema,
  ReopenPeriodRequestSchema,
  type ClosePeriodRequest,
  type GeneratePeriodsRequest,
  type GeneratePeriodsResponse,
  type ListPeriodsQuery,
  type PeriodLifecycleResponse,
  type PeriodResponse,
  type PeriodsListResponse,
  type ReopenPeriodRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import {
  PeriodCalendarService,
  type GenerateCalendarFailure,
} from '../services/period-calendar.service';
import {
  PeriodLifecycleService,
  type PeriodLifecycleFailure,
} from '../services/period-lifecycle.service';

/**
 * `PeriodsController` — admin surface for accounting-period lifecycle +
 * calendar management (TS-085, PDD §11.2, CLAUDE.md §6).
 *
 *   - `GET    /api/v1/admin/periods`                        — list
 *   - `GET    /api/v1/admin/periods/:periodName`            — fetch one
 *   - `POST   /api/v1/admin/periods/generate`               — calendar
 *   - `POST   /api/v1/admin/periods/:periodName/close`      — close
 *   - `POST   /api/v1/admin/periods/:periodName/reopen`     — reopen
 *
 * All endpoints guarded by `AccessTokenGuard`. The write endpoints
 * carry `@Idempotent()` so the Redis-backed Idempotency-Key cache
 * (CLAUDE.md §3.3) covers admin double-click + transient network
 * retries; the service-layer `source_event_id` UNIQUE is the second
 * line of defence for lifecycle events.
 *
 * Permission-string gating (`finance:adjust`, `accounting:close_period`)
 * lands once the shared `packages/nest-auth` package arrives
 * (TS-052-followup-11). Until then the audit row records the actor
 * for review and CLAUDE.md §3.2's row-level read posture is enforced
 * by the existing AccessTokenGuard.
 */
@Controller()
export class PeriodsController {
  private readonly logger = new Logger(PeriodsController.name);

  constructor(
    private readonly lifecycle: PeriodLifecycleService,
    private readonly calendar: PeriodCalendarService,
  ) {}

  /**
   * List accounting periods, newest-first. Cursor-paginated.
   *
   * Default page size 50, capped at 100. The cursor opaqueness lets
   * future schema changes (e.g. moving to (startDate, id) compound
   * cursors) land without breaking v1.
   */
  @Get('api/v1/admin/periods')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(ListPeriodsQuerySchema))
  async listPeriods(@Query() query: ListPeriodsQuery): Promise<PeriodsListResponse> {
    const output = await this.calendar.list({
      ...(query.status !== undefined && { status: query.status }),
      ...(query.cursor !== undefined && { cursor: query.cursor }),
      limit: query.limit ?? LIST_PERIODS_LIMIT_DEFAULT,
    });
    return {
      periods: [...output.periods],
      nextCursor: output.nextCursor,
    };
  }

  /**
   * Fetch a single period by name.
   */
  @Get('api/v1/admin/periods/:periodName')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getPeriod(@Param('periodName') periodName: string): Promise<PeriodResponse> {
    validatePeriodName(periodName);
    const found = await this.calendar.getByName(periodName);
    if (found === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Accounting period "${periodName}" not found.`,
        failureReason: 'period_not_found',
        periodName,
      });
    }
    return found;
  }

  /**
   * Generate monthly accounting periods covering an inclusive range.
   * Idempotent — re-running with the same range only inserts the
   * missing names.
   */
  @Post('api/v1/admin/periods/generate')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  @UsePipes(new ZodValidationPipe(GeneratePeriodsRequestSchema))
  async generatePeriods(
    @Body() body: GeneratePeriodsRequest,
    @Req() request: RequestWithContext,
  ): Promise<GeneratePeriodsResponse> {
    const actorId = requireActor(request);
    const result = await this.calendar.generateMonthly(body.startYearMonth, body.endYearMonth);
    if (!result.ok) {
      throw mapGenerateFailureToHttp(result.failure);
    }
    this.logger.warn(
      {
        actorId,
        startYearMonth: body.startYearMonth,
        endYearMonth: body.endYearMonth,
        requestedCount: result.value.requestedCount,
        createdCount: result.value.createdCount,
        existedCount: result.value.existedCount,
      },
      'periods.calendar.generated',
    );
    return {
      startYearMonth: result.value.startYearMonth,
      endYearMonth: result.value.endYearMonth,
      requestedCount: result.value.requestedCount,
      createdCount: result.value.createdCount,
      existedCount: result.value.existedCount,
      created: [...result.value.created],
      existed: [...result.value.existed],
    };
  }

  /**
   * Close an open accounting period. Records the close in
   * `period_lifecycle_events`; flips `period.status` to `closed`;
   * stamps `closedAt` + `closedByUserId`.
   */
  @Post('api/v1/admin/periods/:periodName/close')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async closePeriod(
    @Param('periodName') periodName: string,
    @Body(new ZodValidationPipe(ClosePeriodRequestSchema)) body: ClosePeriodRequest,
    @Req() request: RequestWithContext,
  ): Promise<PeriodLifecycleResponse> {
    validatePeriodName(periodName);
    const actorId = requireActor(request);
    const occurredAt = body.occurredAt !== undefined ? new Date(body.occurredAt) : new Date();
    const result = await this.lifecycle.close({
      periodName,
      actorUserId: actorId,
      sourceEventId: body.sourceEventId,
      reasonCode: body.reasonCode,
      description: body.description ?? null,
      occurredAt,
    });
    if (!result.ok) {
      throw mapLifecycleFailureToHttp(result.failure);
    }
    this.logger.warn(
      {
        actorId,
        periodName,
        result: result.value.result,
        eventId: result.value.event.id,
        reasonCode: body.reasonCode,
      },
      'periods.close.completed',
    );
    return {
      period: result.value.period,
      event: result.value.event,
      result: result.value.result,
    };
  }

  /**
   * Reopen a closed accounting period. Records the reopen in
   * `period_lifecycle_events`; flips `period.status` to `open`;
   * preserves the prior `closedAt` + `closedByUserId` (the close
   * happened — the audit record stands).
   */
  @Post('api/v1/admin/periods/:periodName/reopen')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async reopenPeriod(
    @Param('periodName') periodName: string,
    @Body(new ZodValidationPipe(ReopenPeriodRequestSchema)) body: ReopenPeriodRequest,
    @Req() request: RequestWithContext,
  ): Promise<PeriodLifecycleResponse> {
    validatePeriodName(periodName);
    const actorId = requireActor(request);
    const occurredAt = body.occurredAt !== undefined ? new Date(body.occurredAt) : new Date();
    const result = await this.lifecycle.reopen({
      periodName,
      actorUserId: actorId,
      sourceEventId: body.sourceEventId,
      reasonCode: body.reasonCode,
      description: body.description ?? null,
      occurredAt,
    });
    if (!result.ok) {
      throw mapLifecycleFailureToHttp(result.failure);
    }
    this.logger.warn(
      {
        actorId,
        periodName,
        result: result.value.result,
        eventId: result.value.event.id,
        reasonCode: body.reasonCode,
      },
      'periods.reopen.completed',
    );
    return {
      period: result.value.period,
      event: result.value.event,
      result: result.value.result,
    };
  }
}

function requireActor(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined || ctx.userId === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function validatePeriodName(periodName: string): void {
  const parsed = PeriodNameSchema.safeParse(periodName);
  if (!parsed.success) {
    throw new UnprocessableEntityException({
      type: 'about:blank',
      title: 'Unprocessable Entity',
      status: 422,
      detail: 'periodName path parameter must be YYYY-MM (e.g. "2026-05").',
      failureReason: 'malformed_period_name',
      periodName,
    });
  }
}

function mapLifecycleFailureToHttp(failure: PeriodLifecycleFailure): never {
  switch (failure.kind) {
    case 'period_not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `Accounting period "${failure.periodName}" not found.`,
        failureReason: failure.kind,
        periodName: failure.periodName,
      });
    case 'period_already_closed':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Accounting period "${failure.periodName}" is already closed.`,
        failureReason: failure.kind,
        periodId: failure.periodId,
        periodName: failure.periodName,
      });
    case 'period_not_closed':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: `Accounting period "${failure.periodName}" is not closed; nothing to reopen.`,
        failureReason: failure.kind,
        periodId: failure.periodId,
        periodName: failure.periodName,
      });
    case 'idempotency_payload_drift':
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'The provided sourceEventId matches a prior event with a different period or kind. Use a fresh sourceEventId for a different action.',
        failureReason: failure.kind,
        sourceEventId: failure.sourceEventId,
        storedKind: failure.storedKind,
        storedPeriodId: failure.storedPeriodId,
      });
  }
}

function mapGenerateFailureToHttp(failure: GenerateCalendarFailure): never {
  switch (failure.kind) {
    case 'range_inverted':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'startYearMonth must be ≤ endYearMonth.',
        failureReason: failure.kind,
        startYearMonth: failure.startYearMonth,
        endYearMonth: failure.endYearMonth,
      });
    case 'range_exceeds_cap':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Requested range spans ${failure.requestedCount} months; cap is ${failure.maxCount}. Split into multiple calls.`,
        failureReason: failure.kind,
        requestedCount: failure.requestedCount,
        maxCount: GENERATE_PERIODS_MAX_COUNT,
      });
    case 'malformed_name':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Year-month "${failure.yearMonth}" is not a valid YYYY-MM name.`,
        failureReason: failure.kind,
        yearMonth: failure.yearMonth,
      });
  }
}
