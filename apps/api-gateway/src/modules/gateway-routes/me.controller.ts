import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { type MeResponse } from '@taste-and-see/contracts';

import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { HouseholdScopeResolver } from '../household-scope/services/household-scope.resolver';
import { RateLimitGuard } from '../rate-limit/guards/rate-limit.guard';

/**
 * `GET /api/v1/me` (TS-140).
 *
 * Derived from the verified access token's `RequestContext`, plus one
 * cached membership read. Returns the actor identity (userId,
 * mfaVerified, roles, tenantScope, households) the client portal needs
 * to render the nav bar + decide which menu items to show. Richer
 * profile data (name, email) lives on a separate downstream endpoint
 * that the portal calls only when needed.
 *
 * **`tenantScope` and `households` answer different questions**
 * (TS-505d2-followup-5a). The first is which household THIS request is
 * acting in; the second is which ones the actor COULD act in. With one
 * membership the scope resolves automatically and the portal shows no
 * picker; with several the scope stays `global` until the client names
 * one via `X-Household-Id`, and without this list the portal has
 * nothing to render the choice from.
 *
 * The membership read goes through `HouseholdScopeResolver`, which the
 * global interceptor has already warmed on this very request — so in
 * practice this is a Redis hit and no downstream call. A failed lookup
 * yields `[]` rather than an error: `/me` is what a portal renders its
 * whole shell from, and taking that down because service-household is
 * unreachable would turn a degraded family surface into a broken
 * session.
 *
 * Guard order: `AccessTokenGuard` runs FIRST so the per-user rate-limit
 * key is correct; `RateLimitGuard` then consumes one slot from the
 * default policy bucket.
 */
@Controller('api/v1/me')
@UseGuards(AccessTokenGuard, RateLimitGuard)
export class MeController {
  constructor(private readonly householdScope: HouseholdScopeResolver) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async me(@Req() request: RequestWithContext): Promise<MeResponse> {
    const ctx = request.requestContext;
    if (ctx === undefined) {
      // Belt-and-braces: AccessTokenGuard MUST have attached this. If
      // the binding broke (refactoring accident), fail closed rather
      // than hand the upstream a partial response.
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: HttpStatus.UNAUTHORIZED,
        detail: 'Authentication required.',
      });
    }

    return {
      userId: ctx.userId,
      sessionId: ctx.sessionId ?? null,
      mfaVerified: ctx.mfaVerified,
      // Present only on impersonation sessions (TS-297): the operator's
      // user id — `userId` above is the impersonated user. Portals key
      // the "Impersonating …" banner off this field.
      ...(ctx.actorOnBehalfOf !== undefined && { actorOnBehalfOf: ctx.actorOnBehalfOf }),
      roles: ctx.roles.map((role) => ({
        name: role.name,
        permissions: [...role.permissions],
        scope: role.scope,
        ...(role.expiresAt !== undefined && { expiresAt: role.expiresAt }),
      })),
      tenantScope: ctx.tenantScope,
      households: [
        ...(await this.householdScope.listMemberships({
          userId: ctx.userId,
          traceId: extractTraceId(request),
        })),
      ],
    };
  }
}

/** Mirrors the proxy controllers' trace-id extraction. */
function extractTraceId(request: RequestWithContext): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
