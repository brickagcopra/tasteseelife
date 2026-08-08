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
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type ListPayoutDisbursementsQuery,
  ListPayoutDisbursementsQuerySchema,
  type PayoutDisbursementResponse,
  type PayoutDisbursementStatus,
  type PayoutDisbursementsListResponse,
  type RunDisbursementSweepRequest,
  RunDisbursementSweepRequestSchema,
  type RunDisbursementSweepResponse,
  type SchedulePayoutDisbursementRequest,
  SchedulePayoutDisbursementRequestSchema,
  type SchedulePayoutDisbursementResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import {
  toPayoutDisbursementResponse,
  toPayoutDisbursementsListResponse,
  toRunDisbursementSweepResponse,
  toSchedulePayoutDisbursementResponse,
} from '../mappers/disbursement.mapper';
import { DisbursementSchedulerService } from '../services/disbursement-scheduler.service';
import { DisbursementsService } from '../services/disbursements.service';

/**
 * Admin-only disbursement endpoints (TS-091).
 *
 *   POST /api/v1/admin/payouts/sweeps
 *     Run a daily disbursement sweep. `dryRun: true` returns the
 *     per-provider decisions without scheduling.
 *
 *   POST /api/v1/admin/payouts/disbursements
 *     Manual per-provider disbursement (ops makegood, dispute-hold
 *     release). Idempotent on operator-supplied `idempotencyKey`.
 *
 *   POST /api/v1/admin/payouts/disbursements/:id/execute
 *     Initiate the Stripe Transfer for a `pending` row whose hold
 *     window has cleared. Idempotent: an `in_transit` / `paid` /
 *     `failed` row returns its current state without re-attempting.
 *
 *   POST /api/v1/admin/payouts/disbursements/:id/cancel
 *     Cancel a `pending` row. Returns `not_cancelable` for non-pending
 *     rows.
 *
 *   GET  /api/v1/admin/payouts/disbursements
 *     Cursor-paginated list with provider / status / scheduled-for
 *     range filters.
 *
 *   GET  /api/v1/admin/payouts/disbursements/:id
 *     Detail view.
 *
 * Authorisation: AccessTokenGuard today; `payouts:write` permission
 * gate lifts in TS-091-followup-10 (lifted alongside TS-090-followup-2).
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class DisbursementsController {
  constructor(
    private readonly disbursements: DisbursementsService,
    private readonly scheduler: DisbursementSchedulerService,
  ) {}

  @Post('api/v1/admin/payouts/sweeps')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RunDisbursementSweepRequestSchema))
  async runSweep(@Body() body: RunDisbursementSweepRequest): Promise<RunDisbursementSweepResponse> {
    const sweepInput: {
      asOfDate: string;
      holdDays?: number;
      minAmountMinor?: number;
      providerIds?: readonly string[];
      dryRun?: boolean;
    } = { asOfDate: body.asOfDate, dryRun: body.dryRun };
    if (body.holdDays !== undefined) sweepInput.holdDays = body.holdDays;
    if (body.minAmountMinor !== undefined) sweepInput.minAmountMinor = body.minAmountMinor;
    if (body.providerIds !== undefined) sweepInput.providerIds = body.providerIds;

    const result = await this.scheduler.runSweep(sweepInput);
    return toRunDisbursementSweepResponse(result);
  }

  @Post('api/v1/admin/payouts/disbursements')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(SchedulePayoutDisbursementRequestSchema))
  async scheduleManual(
    @Body() body: SchedulePayoutDisbursementRequest,
  ): Promise<SchedulePayoutDisbursementResponse> {
    const scheduledFor = parseCalendarDate(body.scheduledFor);
    const scheduleInput: {
      providerId: string;
      amountMinor: number;
      currency: string;
      idempotencyKey: string;
      sourceEventId?: string;
      memo?: string;
      scheduledFor: Date;
      holdDays: number;
    } = {
      providerId: body.providerId,
      amountMinor: body.amountMinor,
      currency: body.currency,
      idempotencyKey: body.idempotencyKey,
      // Manual disbursements pass holdDays=0 — operator action implies
      // the hold has already been considered.
      scheduledFor,
      holdDays: 0,
    };
    if (body.sourceEventId !== undefined) scheduleInput.sourceEventId = body.sourceEventId;
    if (body.memo !== undefined) scheduleInput.memo = body.memo;
    const result = await this.disbursements.scheduleDisbursement(scheduleInput);
    switch (result.outcome) {
      case 'created':
      case 'existing':
        return toSchedulePayoutDisbursementResponse(result.outcome, result.disbursement);
      case 'account_not_found':
        throw new NotFoundException({
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          detail: 'No Stripe Connect Express account is on file for this provider.',
        });
      case 'account_not_active':
        throw new UnprocessableEntityException({
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: `Payout account is not active (status=${result.status}).`,
          failureReason: 'account_not_active',
          accountStatus: result.status,
        });
    }
  }

  @Post('api/v1/admin/payouts/disbursements/:id/execute')
  @HttpCode(HttpStatus.OK)
  async execute(@Param('id') id: string): Promise<PayoutDisbursementResponse> {
    const result = await this.disbursements.executeDisbursement({
      disbursementId: id,
      asOf: new Date(),
    });
    if (result === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No disbursement found with that id.',
      });
    }
    if (result.outcome === 'not_initiable') {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'Disbursement is not initiable — either the hold window has not cleared or the row is in a terminal state.',
        failureReason: 'not_initiable',
        currentStatus: result.disbursement.status,
      });
    }
    // `initiated` and `already_initiated` both return the row.
    return toPayoutDisbursementResponse(result.disbursement);
  }

  @Post('api/v1/admin/payouts/disbursements/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param('id') id: string,
    @Body() body: CancelBody | undefined,
  ): Promise<PayoutDisbursementResponse> {
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    const cancelInput: { disbursementId: string; reason?: string } = { disbursementId: id };
    if (reason !== undefined) cancelInput.reason = reason;
    const result = await this.disbursements.cancelDisbursement(cancelInput);
    if (result === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No disbursement found with that id.',
      });
    }
    if (result.outcome === 'not_cancelable') {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail:
          'Disbursement is not cancelable. Only pending disbursements may be canceled locally.',
        failureReason: 'not_cancelable',
        currentStatus: result.disbursement.status,
      });
    }
    return toPayoutDisbursementResponse(result.disbursement);
  }

  @Get('api/v1/admin/payouts/disbursements')
  @UsePipes(new ZodValidationPipe(ListPayoutDisbursementsQuerySchema))
  async list(
    @Query() query: ListPayoutDisbursementsQuery,
  ): Promise<PayoutDisbursementsListResponse> {
    const input: {
      limit: number;
      cursor?: string;
      providerId?: string;
      status?: PayoutDisbursementStatus;
      scheduledOnOrAfter?: Date;
      scheduledOnOrBefore?: Date;
    } = { limit: query.limit };
    if (query.cursor !== undefined) input.cursor = query.cursor;
    if (query.providerId !== undefined) input.providerId = query.providerId;
    if (query.status !== undefined) input.status = query.status;
    if (query.scheduledOnOrAfter !== undefined) {
      input.scheduledOnOrAfter = parseCalendarDate(query.scheduledOnOrAfter);
    }
    if (query.scheduledOnOrBefore !== undefined) {
      input.scheduledOnOrBefore = parseCalendarDate(query.scheduledOnOrBefore);
    }
    const result = await this.disbursements.list(input);
    return toPayoutDisbursementsListResponse(result.rows, result.nextCursor);
  }

  @Get('api/v1/admin/payouts/disbursements/:id')
  async getById(@Param('id') id: string): Promise<PayoutDisbursementResponse> {
    const record = await this.disbursements.getById(id);
    if (record === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No disbursement found with that id.',
      });
    }
    return toPayoutDisbursementResponse(record);
  }
}

interface CancelBody {
  readonly reason?: string;
}

function parseCalendarDate(yyyymmdd: string): Date {
  const [yStr, mStr, dStr] = yyyymmdd.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}
