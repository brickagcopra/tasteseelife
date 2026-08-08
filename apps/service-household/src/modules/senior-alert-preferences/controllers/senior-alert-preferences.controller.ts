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
  SetSeniorAlertPreferencesRequestSchema,
  type SeniorAlertPreferencesResponse,
  type SetSeniorAlertPreferencesRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { SeniorAlertPreferencesService } from '../services/senior-alert-preferences.service';

/**
 * Per-(senior × family-member) alert subscription HTTP boundary (TS-234).
 *
 * Endpoints:
 *
 *   GET /api/v1/seniors/:seniorId/alert-preferences
 *     Read the authenticated member's *own* three alert-type flags for
 *     the senior. The absence of a stored row is the synthesised default
 *     (operational + safety alerts on, observation-derived alert off).
 *
 *   PUT /api/v1/seniors/:seniorId/alert-preferences
 *     Full-replace of the caller's own three flags. Any active household
 *     member may set their own subscription — there is no manager gate
 *     (cf. consent). The body is the complete three-flag state (the editor
 *     is a three-toggle form, so a partial-merge would be ambiguous).
 *
 * Authentication. Bearer access token; the service layer enforces
 * household membership (row-level). The subscription row is keyed by the
 * authenticated caller's `userId` (from the request context), never by
 * client input — a member can only ever read / write their own row.
 *
 * Idempotency. PUT is naturally idempotent on `(seniorId, userId, flags)`
 * and is decorated with `@Idempotent()` so the global
 * `IdempotencyInterceptor` replays the cached response for any retry
 * within the 24h TTL. A same-key-different-body retry returns 409.
 */
@Controller('api/v1/seniors')
export class SeniorAlertPreferencesController {
  private readonly logger = new Logger(SeniorAlertPreferencesController.name);

  constructor(private readonly alertPreferences: SeniorAlertPreferencesService) {}

  /**
   * Status codes:
   *   200 OK            — body is the alert-preferences response (the
   *                       synthesised default when never set).
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist (or is soft-deleted).
   */
  @Get(':seniorId/alert-preferences')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async get(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorAlertPreferencesResponse> {
    const userId = requireUserId(request);
    return this.alertPreferences.getMyPreferences({ seniorId, requesterUserId: userId });
  }

  /**
   * Status codes:
   *   200 OK            — applied; body is the read-back response.
   *   400 Bad Request   — payload failed validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist.
   */
  @Put(':seniorId/alert-preferences')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async set(
    @Param('seniorId') seniorId: string,
    @Body(new ZodValidationPipe(SetSeniorAlertPreferencesRequestSchema))
    input: SetSeniorAlertPreferencesRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SeniorAlertPreferencesResponse> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), seniorId },
        'alert preferences set carried Idempotency-Key',
      );
    }
    return this.alertPreferences.setMyPreferences({
      seniorId,
      requesterUserId: userId,
      flags: input,
    });
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
