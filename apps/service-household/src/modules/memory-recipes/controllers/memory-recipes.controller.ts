import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  CreateMemoryRecipeRequestSchema,
  UpdateMemoryRecipeRequestSchema,
  type CreateMemoryRecipeRequest,
  type MemoryRecipe,
  type MemoryRecipesListResponse,
  type UpdateMemoryRecipeRequest,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { MemoryRecipesService } from '../services/memory-recipes.service';

/**
 * Senior memory-recipes HTTP boundary (TS-033).
 *
 * Endpoints:
 *
 *   GET    /api/v1/seniors/:seniorId/memory-recipes
 *     List active recipes in family-controlled order.
 *
 *   POST   /api/v1/seniors/:seniorId/memory-recipes
 *     Create a new recipe. 422 if the senior is at the per-senior cap.
 *
 *   PATCH  /api/v1/seniors/:seniorId/memory-recipes/:recipeId
 *     Patch one or more fields. Empty body is 400.
 *
 *   DELETE /api/v1/seniors/:seniorId/memory-recipes/:recipeId
 *     Soft-delete. Idempotent.
 *
 * Authentication. Bearer access token; the service layer enforces
 * household membership.
 *
 * Idempotency. Every write endpoint (POST/PATCH/DELETE) is decorated
 * with `@Idempotent()` so the global `IdempotencyInterceptor` from
 * `@taste-and-see/nest-idempotency` claims a Redis slot per
 * `Idempotency-Key`, body-hashes the request, and replays the cached
 * HTTP response for any retry within the 24h TTL (TS-044-followup-1).
 * A same-key-different-body retry returns 409. The cache short-circuits
 * the handler entirely, closing the per-senior cap race window on the
 * create path documented in TS-033-followup-8.
 */
@Controller('api/v1/seniors')
export class MemoryRecipesController {
  private readonly logger = new Logger(MemoryRecipesController.name);

  constructor(private readonly recipes: MemoryRecipesService) {}

  /**
   * Status codes:
   *   200 OK            — body is the wrapped recipes list.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist (or is soft-deleted).
   */
  @Get(':seniorId/memory-recipes')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async list(
    @Param('seniorId') seniorId: string,
    @Req() request: RequestWithContext,
  ): Promise<MemoryRecipesListResponse> {
    const userId = requireUserId(request);
    return this.recipes.list({ seniorId, requesterUserId: userId });
  }

  /**
   * Status codes:
   *   201 Created       — recipe persisted; body is the created DTO.
   *   400 Bad Request   — payload failed Zod validation.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior does not exist.
   *   422 Unprocessable — senior is at the per-senior recipe cap.
   */
  @Post(':seniorId/memory-recipes')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async create(
    @Param('seniorId') seniorId: string,
    @Body(new ZodValidationPipe(CreateMemoryRecipeRequestSchema)) input: CreateMemoryRecipeRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MemoryRecipe> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), seniorId },
        'memory-recipe create carried Idempotency-Key',
      );
    }
    return this.recipes.create({ seniorId, requesterUserId: userId, input });
  }

  /**
   * Status codes:
   *   200 OK            — updated; body is the read-back DTO.
   *   400 Bad Request   — payload failed validation OR empty body.
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior or recipe does not exist.
   */
  @Patch(':seniorId/memory-recipes/:recipeId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async update(
    @Param('seniorId') seniorId: string,
    @Param('recipeId') recipeId: string,
    @Body(new ZodValidationPipe(UpdateMemoryRecipeRequestSchema)) input: UpdateMemoryRecipeRequest,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<MemoryRecipe> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), seniorId, recipeId },
        'memory-recipe update carried Idempotency-Key',
      );
    }
    return this.recipes.update({ seniorId, recipeId, requesterUserId: userId, input });
  }

  /**
   * Status codes:
   *   204 No Content    — removed (or already removed; idempotent).
   *   401 Unauthorized  — missing / invalid access token.
   *   403 Forbidden     — caller is not a member of the senior's household.
   *   404 Not Found     — senior or recipe does not exist.
   */
  @Delete(':seniorId/memory-recipes/:recipeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async remove(
    @Param('seniorId') seniorId: string,
    @Param('recipeId') recipeId: string,
    @Req() request: RequestWithContext,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<void> {
    const userId = requireUserId(request);
    if (idempotencyKey !== undefined && idempotencyKey.length > 0) {
      this.logger.debug(
        { idempotencyKey: redactKey(idempotencyKey), seniorId, recipeId },
        'memory-recipe remove carried Idempotency-Key',
      );
    }
    await this.recipes.remove({ seniorId, recipeId, requesterUserId: userId });
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
