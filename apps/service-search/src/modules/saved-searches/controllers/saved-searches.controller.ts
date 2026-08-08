import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  type CreateSavedSearchRequest,
  CreateSavedSearchRequestSchema,
  type DeleteSavedSearchResponse,
  type GetSavedSearchResponse,
  type RunSavedSearchResponse,
  type SavedSearch,
  type SavedSearchesListResponse,
  type UpdateSavedSearchRequest,
  UpdateSavedSearchRequestSchema,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { OwnerQuotaExceededError, SavedSearchesService } from '../services/saved-searches.service';

/**
 * Saved-searches authenticated surface (TS-215).
 *
 *   GET    /api/v1/saved-searches              — list mine
 *   GET    /api/v1/saved-searches/:id          — fetch one (TS-215-followup-1)
 *   POST   /api/v1/saved-searches              — create one
 *   PATCH  /api/v1/saved-searches/:id          — rename / change query
 *   POST   /api/v1/saved-searches/:id/run      — bump lastRunAt
 *   DELETE /api/v1/saved-searches/:id          — delete (idempotent)
 *
 * All five routes require a valid access token (`AccessTokenGuard`) and
 * operate on the authenticated `userId` from the request context. The
 * service layer enforces row-level ownership — a caller cannot see /
 * mutate / delete another actor's row even by ID.
 *
 * Failure mapping:
 *   401 — missing / invalid bearer token (guard).
 *   400 — Zod validation failure (pipe).
 *   404 — id not found (or owned by another actor — same response by
 *         design, so a probe can't distinguish "doesn't exist" from
 *         "exists but not yours").
 *   409 — owner has reached the per-actor quota
 *         (`SAVED_SEARCHES_MAX_PER_OWNER`).
 *   422 — empty PATCH body.
 */
@Controller('api/v1/saved-searches')
@UseGuards(AccessTokenGuard)
export class SavedSearchesController {
  constructor(private readonly service: SavedSearchesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(@Req() req: RequestWithContext): Promise<SavedSearchesListResponse> {
    const ownerUserId = requireUserId(req);
    const savedSearches = await this.service.listForOwner(ownerUserId);
    return { savedSearches: [...savedSearches] };
  }

  /**
   * Single-row read (TS-215-followup-1).
   *
   * The /providers page redirects here with `?savedSearchId=…` after the
   * family clicks "Run" on a saved search; it hydrates its filter form
   * from the returned `query` body. Row-level ownership is enforced at
   * the service layer — a row belonging to another actor returns 404
   * with the same shape as "doesn't exist" so a probe can't distinguish.
   */
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async get(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
  ): Promise<GetSavedSearchResponse> {
    const ownerUserId = requireUserId(req);
    const savedSearch = await this.service.findByIdForOwner(ownerUserId, id);
    if (savedSearch === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: HttpStatus.NOT_FOUND,
        detail: `No saved search with id "${id}".`,
      });
    }
    return { savedSearch };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: RequestWithContext,
    @Body(new ZodValidationPipe(CreateSavedSearchRequestSchema))
    body: CreateSavedSearchRequest,
  ): Promise<SavedSearch> {
    const ownerUserId = requireUserId(req);
    try {
      return await this.service.create(ownerUserId, body);
    } catch (err) {
      if (err instanceof OwnerQuotaExceededError) {
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: HttpStatus.CONFLICT,
          detail: `You already have ${err.existing} saved searches (max ${err.max}). Delete one before creating another.`,
        });
      }
      throw err;
    }
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateSavedSearchRequestSchema))
    body: UpdateSavedSearchRequest,
  ): Promise<SavedSearch> {
    const ownerUserId = requireUserId(req);

    // Empty patch — surface a 422 so a misconfigured client doesn't
    // silently succeed without changing anything. The service layer
    // also short-circuits in this branch but the controller gives the
    // caller a clearer signal.
    if (Object.keys(body).length === 0) {
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        detail: 'PATCH body must include at least one field to update.',
      });
    }

    const updated = await this.service.update(ownerUserId, id, body);
    if (updated === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: HttpStatus.NOT_FOUND,
        detail: `No saved search with id "${id}".`,
      });
    }
    return updated;
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.OK)
  async run(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
  ): Promise<RunSavedSearchResponse> {
    const ownerUserId = requireUserId(req);
    const savedSearch = await this.service.run(ownerUserId, id);
    if (savedSearch === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: HttpStatus.NOT_FOUND,
        detail: `No saved search with id "${id}".`,
      });
    }
    return { savedSearch };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Req() req: RequestWithContext,
    @Param('id') id: string,
  ): Promise<DeleteSavedSearchResponse> {
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
