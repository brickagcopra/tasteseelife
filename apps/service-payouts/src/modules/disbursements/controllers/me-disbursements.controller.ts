import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type ListMyPayoutDisbursementsQuery,
  ListMyPayoutDisbursementsQuerySchema,
  type PayoutDisbursementResponse,
  type PayoutDisbursementStatus,
  type PayoutDisbursementsListResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import {
  toPayoutDisbursementResponse,
  toPayoutDisbursementsListResponse,
} from '../mappers/disbursement.mapper';
import { DisbursementsService } from '../services/disbursements.service';

/**
 * Provider self-service disbursement endpoints (TS-091).
 *
 *   GET /api/v1/payouts/me/disbursements
 *     Cursor-paginated list of the authenticated provider's
 *     disbursement history.
 *
 *   GET /api/v1/payouts/me/disbursements/:id
 *     Detail view of a single disbursement. 404 when the disbursement
 *     id doesn't belong to the authenticated provider — the row-level
 *     check is enforced at the service layer.
 *
 * Phase 1 maps the authenticated `userId` to the `providerId` 1:1
 * (mirror of the TS-090 ConnectController). TS-090-followup-3 lifts
 * this to a real provider lookup.
 */
@Controller()
export class MeDisbursementsController {
  constructor(private readonly disbursements: DisbursementsService) {}

  @Get('api/v1/payouts/me/disbursements')
  @UseGuards(AccessTokenGuard)
  @UsePipes(new ZodValidationPipe(ListMyPayoutDisbursementsQuerySchema))
  async listMine(
    @Query() query: ListMyPayoutDisbursementsQuery,
    @Req() request: RequestWithContext,
  ): Promise<PayoutDisbursementsListResponse> {
    const providerId = extractProviderIdFromRequest(request);
    const input: {
      limit: number;
      providerId: string;
      cursor?: string;
      status?: PayoutDisbursementStatus;
    } = { limit: query.limit, providerId };
    if (query.cursor !== undefined) input.cursor = query.cursor;
    if (query.status !== undefined) input.status = query.status;
    const result = await this.disbursements.list(input);
    return toPayoutDisbursementsListResponse(result.rows, result.nextCursor);
  }

  @Get('api/v1/payouts/me/disbursements/:id')
  @UseGuards(AccessTokenGuard)
  async getMine(
    @Param('id') id: string,
    @Req() request: RequestWithContext,
  ): Promise<PayoutDisbursementResponse> {
    const providerId = extractProviderIdFromRequest(request);
    const record = await this.disbursements.getById(id);
    if (record === null || record.providerId !== providerId) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'No disbursement found with that id for the authenticated provider.',
      });
    }
    return toPayoutDisbursementResponse(record);
  }
}

function extractProviderIdFromRequest(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new NotFoundException({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'request context missing — provider self-service routes require authentication',
    });
  }
  // Phase 1: user id IS the provider id. TS-090-followup-3 lifts this.
  return ctx.userId;
}
