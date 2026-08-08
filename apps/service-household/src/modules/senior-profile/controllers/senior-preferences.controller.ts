import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  BulkUpsertSeniorPreferencesRequestSchema,
  type BulkUpsertSeniorPreferencesRequest,
  type SeniorPreferencesResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { SeniorPreferencesService } from '../services/senior-preferences.service';

/**
 * Senior memory profile HTTP boundary (TS-033).
 *
 * Endpoints:
 *
 *   GET    /api/v1/seniors/:seniorId/preferences
 *     List every preference entry for the senior, sorted ascending
 *     by key.
 *
 *   PATCH  /api/v1/seniors/:seniorId/preferences
 *     Bulk merge-upsert: each entry is `{key, value}` where
 *       - `value: string` upserts the row.
 *       - `value: null`   deletes the row.
 *     Keys not present in the entries array are untouched.
 *
 * PATCH chosen over PUT because the operation is merge-semantics
 * (PUT-replaces would force the client to round-trip the entire map
 * on every change). Service layer rejects empty bodies + duplicate
 * keys with 400.
 *
 * Authentication. Bearer access token; the service layer enforces
 * household membership.
 *
 * Idempotency. Two layers — (1) PATCH is naturally idempotent on
 * `(seniorId, entries)`; (2) the endpoint is decorated with
 * `@Idempotent()` so the global `IdempotencyInterceptor` from
 * `@taste-and-see/nest-idempotency` claims a Redis slot per
 * `Idempotency-Key`, body-hashes the request, and replays the cached
 * HTTP response for any retry within the 24h TTL (TS-044-followup-1).
 * A same-key-different-body retry returns 409.
 */
@Controller('api/v1/seniors')
export class SeniorPreferencesController {
  private readonly logger = new Logger(SeniorPreferencesController.name);

  constructor(private readonly preferences: SeniorPreferencesService) {}

  /**
   * Status codes:
   *   200 OK            — body is the wrapped preferences list.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist (or is soft-deleted).
   */
  @Get(':seniorId/preferences')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async list(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorPreferencesResponse> {
    const userId = requireUserId(request);
    return this.preferences.list({ seniorId, requesterUserId: userId });
  }

  /**
   * Status codes:
   *   200 OK            — applied; body is the read-back list.
   *   400 Bad Request   — payload failed validation OR empty entries
   *                       OR duplicate keys in the entries array.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist.
   *   422 Unprocessable — request would push the per-senior entry
   *                       count above the cap.
   */
  @Patch(':seniorId/preferences')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async bulkUpsert(
    @Param('seniorId') seniorId: string,
    @Body(new ZodValidationPipe(BulkUpsertSeniorPreferencesRequestSchema))
    input: BulkUpsertSeniorPreferencesRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SeniorPreferencesResponse> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), seniorId },
        'preferences bulk-upsert carried Idempotency-Key',
      );
    }
    return this.preferences.bulkUpsert({ seniorId, requesterUserId: userId, input });
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
