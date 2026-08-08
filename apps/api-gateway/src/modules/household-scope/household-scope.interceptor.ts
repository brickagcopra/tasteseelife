import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import { HOUSEHOLD_SCOPE_HEADER } from '@taste-and-see/contracts';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import { HouseholdScopeResolver } from './services/household-scope.resolver';

/**
 * Establishes the household tenant scope on every authenticated gateway
 * request (TS-505d2-followup-5).
 *
 * **What was broken.** `TokenService.signAccessToken` defaults
 * `tenantScope` to `global` and no caller in the platform has ever passed
 * anything else — a repo-wide sweep of service-identity returns exactly
 * one occurrence of the field, that default. Thirteen handlers across
 * service-booking, service-concierge and service-trust-safety resolve the
 * acting household from `requestContext.tenantScope` and deliberately
 * refuse a body-supplied id (TS-301a — that asymmetry IS the trust
 * boundary). So the family dashboard, wellness trends, wellness anomalies,
 * concierge assignments / onboarding / enrichment / emergency / tickets,
 * and "report a concern" were all unreachable by any real user. The gates
 * are right; nothing had ever been built to satisfy them.
 *
 * **Why here.** The gateway recovers the actor once (`AccessTokenGuard`)
 * and signs it into the `x-ts-trust-*` envelope that every downstream
 * consumes, so enriching the context at this one point covers all thirteen
 * handlers — no per-route sweep with a route left out, which is the
 * failure mode this codebase keeps meeting. It is also the only layer
 * allowed to ask: household membership lives in service-household's
 * schema, §2.3 forbids service-identity reading it, and §2.3 names gateway
 * aggregation as the sanctioned synchronous cross-service read.
 *
 * **An interceptor, not a guard.** Global guards run BEFORE route-level
 * guards, so a guard here would run before `AccessTokenGuard` had put an
 * actor on the request. Interceptors run after every guard, which is
 * exactly the ordering this needs.
 *
 * **It only ever narrows.** A request whose context is already non-global
 * is left untouched, an unauthenticated request is left untouched, and a
 * failure to resolve leaves the request `global` — i.e. refused by the
 * household-scoped routes, the platform's behaviour before this existed.
 * The single case that raises is a client naming a household it does not
 * belong to, which is a 403 rather than a silent fall-through.
 */
@Injectable()
export class HouseholdScopeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HouseholdScopeInterceptor.name);

  constructor(private readonly resolver: HouseholdScopeResolver) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const ctx = request.requestContext;

    // No actor — a public route (signup, login, the public blog). Nothing
    // to scope.
    if (ctx === undefined) return next.handle();

    // Already scoped by something upstream. Today nothing does this, but
    // if a partner-portal token ever carries a `tenant` scope (TS-400),
    // overwriting it here would silently demote a partner request to a
    // household one. Narrowing only.
    if (ctx.tenantScope.type !== 'global') return next.handle();

    const resolution = await this.resolver.resolve({
      userId: ctx.userId,
      requestedHouseholdId: request.header(HOUSEHOLD_SCOPE_HEADER),
      traceId: extractTraceId(request),
    });

    switch (resolution.kind) {
      case 'scoped':
        // Replace rather than mutate: `RequestContext` is a readonly
        // shape, and the object is handed to `AuthContextSignerService`
        // by reference — a fresh object makes it obvious that what gets
        // signed is what was decided here.
        request.requestContext = { ...ctx, tenantScope: resolution.scope };
        return next.handle();

      case 'forbidden':
        throw new ForbiddenException({
          type: 'about:blank',
          title: 'Forbidden',
          status: HttpStatus.FORBIDDEN,
          detail: 'You are not a member of the requested household.',
        });

      case 'unscoped':
        // Debug, not warn: `no_memberships` is the normal state for every
        // staff, provider and partner account on the platform, and a warn
        // per request would be pure noise. The two reasons that ARE
        // operationally interesting (`disabled`, `lookup_failed`) already
        // log from the resolver, where they happen.
        this.logger.debug(
          { userId: ctx.userId, reason: resolution.reason },
          'request left global-scoped',
        );
        return next.handle();
    }
  }
}

/**
 * Express request shape with the `requestContext` slot `AccessTokenGuard`
 * populates. Declared locally for the same reason the guard's own copy is
 * — no global `express` module augmentation.
 */
interface RequestWithContext extends Request {
  requestContext?: RequestContext;
}

/** Mirrors the proxy controllers' trace-id extraction. */
function extractTraceId(request: Request): string | undefined {
  const candidates = [request.headers['x-trace-id'], request.headers['x-request-id']];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
