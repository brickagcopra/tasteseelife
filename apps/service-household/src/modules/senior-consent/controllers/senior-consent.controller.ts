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
  SetSeniorConsentRequestSchema,
  type SeniorConsentResponse,
  type SetSeniorConsentRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { SeniorConsentService } from '../services/senior-consent.service';

/**
 * Senior family-observability consent HTTP boundary (TS-238).
 *
 * Endpoints:
 *
 *   GET /api/v1/seniors/:seniorId/consent
 *     Read the four surface-visibility flags + audit metadata + the
 *     caller's `canManage` capability. Any active household member may
 *     read; the absence of a stored row is the all-`false` opt-out
 *     default (CLAUDE.md §12).
 *
 *   PUT /api/v1/seniors/:seniorId/consent
 *     Full-replace of the four flags. Authorised for the primary payer
 *     and the senior end-user only — a family observer gets 403. The
 *     body is the complete four-flag state (the editor is a four-toggle
 *     form, so a partial-merge would be ambiguous).
 *
 * Authentication. Bearer access token; the service layer enforces
 * household membership (row-level) and the manager-role capability.
 *
 * Idempotency. PUT is naturally idempotent on `(seniorId, flags)` and is
 * decorated with `@Idempotent()` so the global `IdempotencyInterceptor`
 * replays the cached response for any retry within the 24h TTL
 * (TS-044-followup-1). A same-key-different-body retry returns 409.
 */
@Controller('api/v1/seniors')
export class SeniorConsentController {
  private readonly logger = new Logger(SeniorConsentController.name);

  constructor(private readonly consent: SeniorConsentService) {}

  /**
   * Status codes:
   *   200 OK            — body is the consent response (all-false default
   *                       when never set).
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist (or is soft-deleted).
   */
  @Get(':seniorId/consent')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async get(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<SeniorConsentResponse> {
    const userId = requireUserId(request);
    return this.consent.getConsent({ seniorId, requesterUserId: userId });
  }

  /**
   * Status codes:
   *   200 OK            — applied; body is the read-back consent response.
   *   400 Bad Request   — payload failed validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household,
   *                       OR is a family observer (cannot set consent).
   *   404 Not Found     — senior does not exist.
   */
  @Put(':seniorId/consent')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async set(
    @Param('seniorId') seniorId: string,
    @Body(new ZodValidationPipe(SetSeniorConsentRequestSchema)) input: SetSeniorConsentRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SeniorConsentResponse> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), seniorId },
        'consent set carried Idempotency-Key',
      );
    }
    return this.consent.setConsent({ seniorId, requesterUserId: userId, flags: input });
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
