import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  type CreateFavoriteProviderRequest,
  CreateFavoriteProviderRequestSchema,
  type CreateFavoriteProviderResponse,
  type DeleteFavoriteProviderResponse,
  type FavoriteProvidersListResponse,
  FAVORITE_PROVIDER_PROVIDER_ID_MAX_LENGTH,
  FAVORITE_PROVIDER_SENIOR_ID_MAX_LENGTH,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { z } from 'zod';

import {
  FavoriteProvidersService,
  OwnerQuotaExceededError,
} from '../services/favorite-providers.service';

/**
 * Favourite-providers authenticated surface (TS-215).
 *
 *   GET    /api/v1/favorite-providers          — list mine (filterable)
 *   POST   /api/v1/favorite-providers          — upsert one (idempotent)
 *   DELETE /api/v1/favorite-providers/:id      — delete (idempotent)
 *
 * All three routes require a valid access token (`AccessTokenGuard`) and
 * operate on the authenticated `userId` from the request context. The
 * service layer enforces row-level ownership — a caller cannot see /
 * mutate / delete another actor's row even by ID.
 *
 * List query filters:
 *
 *   `?providerId=<id>`  — used by the provider-detail page's heart
 *                          toggle to determine the current state.
 *   `?seniorId=<id>`    — only favourites for that senior.
 *   `?seniorId=null`    — only no-senior favourites.
 *
 * Failure mapping:
 *   401 — missing / invalid bearer token (guard).
 *   400 — Zod validation failure (pipe).
 *   409 — owner has reached the per-actor quota
 *         (`FAVORITE_PROVIDERS_MAX_PER_OWNER`).
 */
@Controller('api/v1/favorite-providers')
@UseGuards(AccessTokenGuard)
export class FavoriteProvidersController {
  constructor(private readonly service: FavoriteProvidersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @Req() req: RequestWithContext,
    @Query('providerId') providerIdRaw?: string,
    @Query('seniorId') seniorIdRaw?: string,
  ): Promise<FavoriteProvidersListResponse> {
    const ownerUserId = requireUserId(req);

    const providerId = parseOptionalId(
      providerIdRaw,
      FAVORITE_PROVIDER_PROVIDER_ID_MAX_LENGTH,
      'providerId',
    );

    // `seniorId=null` is the explicit "no-senior favourites only"
    // filter — treat the literal string `'null'` and the URL-decoded
    // empty-string both as that signal.
    let seniorIdFilter: string | null | undefined;
    if (seniorIdRaw === undefined) {
      seniorIdFilter = undefined;
    } else if (seniorIdRaw === 'null' || seniorIdRaw === '') {
      seniorIdFilter = null;
    } else {
      seniorIdFilter = parseOptionalId(
        seniorIdRaw,
        FAVORITE_PROVIDER_SENIOR_ID_MAX_LENGTH,
        'seniorId',
      );
    }

    const favorites = await this.service.listForOwner(ownerUserId, {
      ...(providerId !== undefined && { providerId }),
      ...(seniorIdFilter !== undefined && { seniorId: seniorIdFilter }),
    });
    return { favorites: [...favorites] };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Req() req: RequestWithContext,
    @Body(new ZodValidationPipe(CreateFavoriteProviderRequestSchema))
    body: CreateFavoriteProviderRequest,
  ): Promise<CreateFavoriteProviderResponse> {
    const ownerUserId = requireUserId(req);
    try {
      return await this.service.upsert(ownerUserId, body);
    } catch (err) {
      if (err instanceof OwnerQuotaExceededError) {
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: HttpStatus.CONFLICT,
          detail: `You already have ${err.existing} favorite providers (max ${err.max}). Remove one before adding another.`,
        });
      }
      throw err;
    }
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
  ): Promise<DeleteFavoriteProviderResponse> {
    const ownerUserId = requireUserId(req);
    const outcome = await this.service.delete(ownerUserId, id);
    return { outcome, id };
  }
}

function requireUserId(req: RequestWithContext): string {
  const ctx = req.requestContext;
  if (!ctx || typeof ctx.userId !== 'string' || ctx.userId.length === 0) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: HttpStatus.UNAUTHORIZED,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

/**
 * Parse an optional query-string id (non-empty, length-capped). Returns
 * undefined when the parameter is absent. Throws on invalid input via
 * Zod so the global Nest exception filter surfaces a 400.
 */
function parseOptionalId(
  raw: string | undefined,
  maxLength: number,
  fieldName: string,
): string | undefined {
  if (raw === undefined) return undefined;
  return z
    .string()
    .min(1, `${fieldName} must be non-empty`)
    .max(maxLength, `${fieldName} must be at most ${maxLength} characters`)
    .parse(raw);
}
