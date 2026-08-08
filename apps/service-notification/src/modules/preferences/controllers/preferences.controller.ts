import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  type UpsertPreferencesRequest,
  UpsertPreferencesRequestSchema,
  type UserPreferencesResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { toUserPreferencesDto } from '../mappers/preferences.mapper';
import { DuplicatePreferenceEntryError, PreferencesService } from '../services/preferences.service';

/**
 * Self-service preferences endpoints (TS-073).
 *
 *   GET  /api/v1/notification/preferences/me  — read the resolved view.
 *   PUT  /api/v1/notification/preferences/me  — full-replace upsert.
 *
 * Both routes require a valid access token (`AccessTokenGuard`) and
 * operate on the authenticated `userId` from the request context. The
 * Phase-1 surface intentionally lets a user mutate only their own
 * preferences — admin-on-behalf overrides land alongside TS-126 admin
 * user management.
 *
 * Failure mapping:
 *   401 — missing / invalid bearer token (guard).
 *   400 — Zod validation failure (pipe).
 *   422 — duplicate `(channel, category)` entry in the request body.
 */
@Controller()
@UseGuards(AccessTokenGuard)
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get('api/v1/notification/preferences/me')
  async getMyPreferences(@Req() req: RequestWithContext): Promise<UserPreferencesResponse> {
    const userId = requireUserId(req);
    const resolved = await this.preferences.getForUser(userId);
    return toUserPreferencesDto(resolved);
  }

  @Put('api/v1/notification/preferences/me')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(UpsertPreferencesRequestSchema))
  async upsertMyPreferences(
    @Req() req: RequestWithContext,
    @Body() body: UpsertPreferencesRequest,
  ): Promise<UserPreferencesResponse> {
    const userId = requireUserId(req);
    try {
      const resolved = await this.preferences.upsertForUser(userId, body);
      return toUserPreferencesDto(resolved);
    } catch (err) {
      if (err instanceof DuplicatePreferenceEntryError) {
        throw new UnprocessableEntityException({
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: `Duplicate preference entry for (${err.channel}, ${err.category}).`,
        });
      }
      throw err;
    }
  }
}

function requireUserId(req: RequestWithContext): string {
  const ctx = req.requestContext;
  if (!ctx || typeof ctx.userId !== 'string' || ctx.userId.length === 0) {
    // Guard already enforces a valid token; this is belt-and-braces in
    // case a future change breaks the contract.
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}
