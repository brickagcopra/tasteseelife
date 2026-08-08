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
  RecordSearchClickRequestSchema,
  type RecordSearchClickRequest,
  type RecordSearchClickResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';

import { SearchClickEmitter } from '../services/search-click.emitter';

/**
 * Search result-click ingest surface (TS-217-prep-4b).
 *
 *   `POST /api/v1/search/clicks` — the family-portal reports that a user
 *   opened a provider from a `/providers` results list.
 *
 * Guarded by `AccessTokenGuard` (every caller holds a valid family-portal JWT).
 * The actor is read from the access-token request context and server-stamped
 * onto the emitted `search.result_clicked` event — never trusted from the body
 * (CLAUDE.md §3.2). The body carries only the three correlation fields the
 * client observed in the results UI (`searchId`, `providerId`, `position`).
 *
 * **Best-effort telemetry.** A click is never a correctness-bearing write
 * (mirrors `search.performed`). The handler returns `202 Accepted` regardless
 * of whether the best-effort outbox append succeeded; `accepted` reflects the
 * append outcome for observability, but the client (a `navigator.sendBeacon`
 * from the results page) ignores the body and a telemetry loss never fails a
 * navigation.
 */
@Controller('api/v1/search/clicks')
export class SearchClicksController {
  constructor(private readonly emitter: SearchClickEmitter) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AccessTokenGuard)
  async record(
    @Req() req: RequestWithContext,
    @Body(new ZodValidationPipe(RecordSearchClickRequestSchema))
    body: RecordSearchClickRequest,
  ): Promise<RecordSearchClickResponse> {
    const actorUserId = requireUserId(req);
    const accepted = await this.emitter.emitSearchResultClicked({
      searchId: body.searchId,
      actorUserId,
      providerId: body.providerId,
      position: body.position,
    });
    return { accepted };
  }
}

/**
 * Extract the authenticated actor's userId from the request context the
 * `AccessTokenGuard` seeds. The guard guarantees a context on this route; the
 * defensive 401 keeps the actor non-null for the server-stamped event.
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
