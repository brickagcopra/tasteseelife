import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  UpsertHouseholdAccessInstructionsRequestSchema,
  type HouseholdAccessInstructionsResponse,
  type UpsertHouseholdAccessInstructionsRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { HouseholdAccessService } from '../services/household-access.service';

/**
 * Household access-instructions HTTP boundary (TS-032).
 *
 * Two endpoints:
 *
 *   PUT  /api/v1/households/:householdId/access-instructions
 *     Idempotent upsert of the encrypted access-instructions blob. The
 *     body is the full payload — every save is a complete picture.
 *     Empty payload clears the blob AND `access_instructions_updated_at`.
 *
 *   GET  /api/v1/households/:householdId/access-instructions
 *     Decrypted read of the current payload. Empty-shape response when
 *     the form has never been completed.
 *
 * Authentication. Bearer access token verified by `AccessTokenGuard`;
 * service-layer checks household membership.
 *
 * Idempotency. Two layers — (1) PUT is naturally idempotent on
 * `(householdId, body)`; (2) the endpoint is decorated with
 * `@Idempotent()` so the global `IdempotencyInterceptor` from
 * `@taste-and-see/nest-idempotency` claims a Redis slot per
 * `Idempotency-Key` and replays the cached HTTP response for any
 * retry within the 24h TTL (TS-044-followup-1).
 */
@Controller('api/v1/households')
export class HouseholdAccessController {
  private readonly logger = new Logger(HouseholdAccessController.name);

  constructor(private readonly access: HouseholdAccessService) {}

  /**
   * PUT /api/v1/households/:householdId/access-instructions
   *
   * Status codes:
   *   200 OK            — payload persisted; body is the read-back DTO.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the household.
   *   404 Not Found     — household does not exist (or is soft-deleted).
   */
  @Put(':householdId/access-instructions')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async upsert(
    @Param('householdId') householdId: string,
    @Body(new ZodValidationPipe(UpsertHouseholdAccessInstructionsRequestSchema))
    input: UpsertHouseholdAccessInstructionsRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<HouseholdAccessInstructionsResponse> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), householdId },
        'access-instructions upsert carried Idempotency-Key',
      );
    }
    return this.access.upsert({ householdId, requesterUserId: userId, payload: input });
  }

  /**
   * GET /api/v1/households/:householdId/access-instructions
   *
   * Status codes:
   *   200 OK            — body is the response DTO (empty fields when
   *                       no payload has been persisted).
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the household.
   *   404 Not Found     — household does not exist (or is soft-deleted).
   */
  @Get(':householdId/access-instructions')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async get(
    @Param('householdId') householdId: string,
    @Req() request: RequestWithContext,
  ): Promise<HouseholdAccessInstructionsResponse> {
    const userId = requireUserId(request);
    return this.access.get({ householdId, requesterUserId: userId });
  }
}

function requireUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function redactKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}
