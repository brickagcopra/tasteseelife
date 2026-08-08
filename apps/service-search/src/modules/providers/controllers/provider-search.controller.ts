import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  SearchProvidersRequestSchema,
  type SearchProvidersRequest,
  type SearchProvidersResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { ProviderSearchService } from '../services/provider-search.service';
import { deriveSearchAudience } from '../services/search-audience';
import { SearchAnalyticsEmitter } from '../services/search-analytics.emitter';

/**
 * Public provider-discovery surface (TS-111).
 *
 *   `POST /api/v1/search/providers` — query the index.
 *
 * Guarded by `AccessTokenGuard` (every caller must hold a valid family-
 * portal / provider-portal / admin JWT). The internal index-management
 * surfaces live in `ProviderIndexController` behind a separate
 * shared-secret guard.
 *
 * **TS-217-prep-1.** After the query resolves, the handler fires a
 * best-effort `search.performed` analytics event via
 * `SearchAnalyticsEmitter` (the actor is read from the access-token
 * request context — never client-supplied). The emit is awaited but the
 * emitter swallows every failure, so analytics never breaks a search.
 *
 * **TS-217-prep-4a.** The handler mints a `searchId` correlation token
 * up front, returns it on the response, AND threads it into the emit so
 * the event's envelope `eventId` matches the token the client received.
 * The family-portal echoes this token on `search.result_clicked`
 * (prep-4b) and `booking.created` (prep-4c) to close the relevance
 * funnel. Minted unconditionally (even if the best-effort emit drops) so
 * the response contract is always satisfied.
 */
@Controller('api/v1/search/providers')
export class ProviderSearchController {
  constructor(
    private readonly service: ProviderSearchService,
    private readonly analytics: SearchAnalyticsEmitter,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async search(
    @Req() req: RequestWithContext,
    @Body(new ZodValidationPipe(SearchProvidersRequestSchema))
    body: SearchProvidersRequest,
  ): Promise<SearchProvidersResponse> {
    const actorUserId = requireUserId(req);
    const searchId = randomUUID();
    // TS-218b — derive the ad-targeting audience for the viewer so the
    // service can reserve sponsored top slots (Phase-1 derivation is minimal
    // + fail-closed; see `deriveSearchAudience`).
    const audience = deriveSearchAudience();
    const result = await this.service.search(body, { audience });
    const response: SearchProvidersResponse = { ...result, searchId };
    await this.analytics.emitSearchPerformed({ searchId, actorUserId, request: body, response });
    return response;
  }
}

/**
 * Extract the authenticated actor's userId from the request context the
 * `AccessTokenGuard` seeds. The guard guarantees a context on this
 * route, but the defensive 401 keeps the actor non-null for the analytics
 * event (server-stamped, never client-supplied — CLAUDE.md §3.2).
 */
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
