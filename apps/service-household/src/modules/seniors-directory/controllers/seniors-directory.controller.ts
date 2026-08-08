import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { MySeniorsResponse } from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';

import { SeniorsDirectoryService } from '../services/seniors-directory.service';

/**
 * "My seniors" directory HTTP boundary (TS-214).
 *
 *   GET /api/v1/me/seniors
 *     List every active senior in a household the authenticated user
 *     actively belongs to. The family-portal entry point into the
 *     per-senior surfaces (preference editor, intake, memory recipes).
 *
 * Authentication. Bearer access token verified by `AccessTokenGuard`;
 * the service-layer membership query is the row-level authorisation —
 * a user only ever sees seniors in households they belong to.
 *
 * No mutation here → no `@Idempotent()`. Read-only list.
 */
@Controller('api/v1/me/seniors')
export class SeniorsDirectoryController {
  constructor(private readonly directory: SeniorsDirectoryService) {}

  /**
   * Status codes:
   *   200 OK            — body is `{ seniors: [...] }` (empty array when
   *                       the user has no active memberships / seniors).
   *   401 Unauthorized  — missing / invalid access token.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async list(@Req() request: RequestWithContext): Promise<MySeniorsResponse> {
    const userId = requireUserId(request);
    return this.directory.listForUser({ requesterUserId: userId });
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
