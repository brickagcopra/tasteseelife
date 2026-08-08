import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { InvalidTokenError, verifyAccessToken, type RequestContext } from '@taste-and-see/auth-sdk';
import { TRUST_HEADERS, verifyTrustHeaders } from '@taste-and-see/nest-internal-trust';
import type { Request } from 'express';

import { JWT_VERIFIER_OPTIONS_TOKEN } from './module/tokens';
import type { ValidatedNestAuthOptions } from './module/options';

/**
 * Bearer-token auth guard for every Taste & See service.
 *
 * Reads `Authorization: Bearer <jwt>` from the incoming request and
 * verifies the JWT via `@taste-and-see/auth-sdk`'s `verifyAccessToken`
 * against the configured HS256 secret + pinned issuer + pinned audience.
 * On success, attaches the decoded `RequestContext` to the request as
 * `requestContext` so downstream handlers + interceptors + the
 * `PermissionGuard` consume the same shape.
 *
 * Every failure mode collapses to a generic 401 with a constant
 * `about:blank` Problem Details body — no oracle that distinguishes
 * "tampered token" from "expired token" from "wrong-issuer token".
 *
 * **Where to apply.** Apply on any controller route that demands an
 * authenticated actor:
 *
 *   ```ts
 *   @UseGuards(AccessTokenGuard)
 *   @Get('me')
 *   getMe(@Req() req: RequestWithContext) {
 *     return { userId: req.requestContext?.userId };
 *   }
 *   ```
 *
 * **Two ways to establish the actor, and why (TS-140-followup-1a).**
 * The api-gateway does NOT forward the caller's bearer token
 * downstream. It verifies the JWT at the edge and mints a signed,
 * time-bounded `x-ts-trust-*` envelope carrying the recovered actor
 * (`DownstreamHttpClient` → `AuthContextSignerService`). A downstream
 * service that accepted only a bearer was therefore **unreachable
 * through the gateway** — every proxied route returned 401. That is
 * what this guard's trust path fixes.
 *
 * Order and exclusivity:
 *
 *   1. If the request carries a trust **signature** and this service was
 *      wired with `internalTrust`, the envelope is verified and the
 *      bearer is never consulted. A present-but-invalid envelope is a
 *      401, never a fallback — see `hasTrustEnvelope` below.
 *   2. Otherwise a bearer JWT is verified exactly as before.
 *
 * `internalTrust` is optional, so a service that has not been migrated
 * behaves identically to before this change and the rollout stays
 * per-service and revertable, as TS-140-followup-1a asks.
 *
 * **Why this guard rather than `TrustHeaderGuard`.** The shared package
 * `@taste-and-see/nest-internal-trust` also exports a standalone
 * `TrustHeaderGuard` (trust-only, no bearer). Swapping it in per route
 * would mean editing every `@UseGuards(AccessTokenGuard)` site on the
 * platform — and a route *missed* by that sweep is a 401 in production,
 * which is precisely the defect being fixed. Widening the guard every
 * route already names removes that failure mode by construction.
 * `TrustHeaderGuard` remains the right choice once TS-151's
 * NetworkPolicy cordons downstream routes and the bearer path can be
 * dropped per service.
 *
 * **DI binding.** The guard injects `JWT_VERIFIER_OPTIONS_TOKEN` so
 * each service wires its own env-sourced options once via
 * `NestAuthModule.forRoot({ jwtAccessSecret, jwtIssuer, jwtAudience })`.
 * Originally TS-022 / TS-051 etc. bound the guard to a per-service
 * `ENV_TOKEN`; this lift collapses 13 verbatim copies into one
 * package while preserving the per-service config surface.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly logger = new Logger(AccessTokenGuard.name);

  constructor(
    @Inject(JWT_VERIFIER_OPTIONS_TOKEN)
    private readonly options: ValidatedNestAuthOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithContext>();

    // ── Path 1: the gateway trust envelope (TS-140-followup-1a) ────────
    //
    // Checked FIRST, and — when an envelope is present — checked to the
    // exclusion of the bearer path. A request that carries an envelope is
    // claiming to have come from the gateway; if that envelope does not
    // verify, the honest outcomes are a rotated secret, a clock skew, or
    // tampering, and all three are things an operator must see. Falling
    // back to a bearer would turn every one of them into a silently
    // working request, which is how a broken signing secret survives a
    // deploy unnoticed.
    const trust = this.options.internalTrust;
    if (trust !== null && hasTrustEnvelope(request)) {
      const result = verifyTrustHeaders(request.headers, {
        signingSecret: trust.signingSecret,
        maxAgeSeconds: trust.maxAgeSeconds,
        futureToleranceSeconds: trust.futureToleranceSeconds,
      });
      if (result.kind !== 'ok') {
        // Label only — the header values may carry a legitimately-signed
        // PII-bearing actor identity the logger's redactor cannot see at
        // this layer. Same posture as `TrustHeaderGuard`.
        this.logger.warn(`trust-header verification failed: ${result.kind}`);
        throw new UnauthorizedException(unauthorizedBody());
      }
      request.requestContext = result.actor;
      return true;
    }

    // ── Path 2: a bearer token from a direct caller ────────────────────
    const token = extractBearerToken(request);
    if (token === null) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    let ctx: RequestContext;
    try {
      ctx = verifyAccessToken(token, {
        secret: this.options.jwtAccessSecret,
        algorithms: ['HS256'],
        audience: this.options.jwtAudience,
        issuer: this.options.jwtIssuer,
      });
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        // Generic 401 — same body for every failure mode.
        throw new UnauthorizedException(unauthorizedBody());
      }
      throw err;
    }

    request.requestContext = ctx;
    return true;
  }
}

/**
 * Express request shape with the optional `requestContext` slot the
 * guard populates. The augmentation is kept local to this package
 * rather than module-augmenting `express`'s `Request` type globally
 * (a global augmentation would couple every workspace that pulls in
 * `@taste-and-see/auth-sdk` to the same `requestContext` field).
 */
export interface RequestWithContext extends Request {
  requestContext?: RequestContext;
}

/**
 * Does this request claim to carry a gateway trust envelope?
 *
 * Keyed on the SIGNATURE header alone, deliberately. Any other choice
 * makes the envelope partially forgeable in a specific way: if presence
 * were keyed on, say, the user-id header, a caller could send that one
 * header and no signature and be routed to the trust path — which fails
 * closed, so that is safe — but if presence required ALL headers, a
 * caller could strip one header from a real envelope and be routed to
 * the bearer path instead, downgrading a tampered request to a merely
 * unauthenticated one. The signature is the header whose presence means
 * "someone intended this to be verified".
 */
function hasTrustEnvelope(request: Request): boolean {
  return typeof request.headers[TRUST_HEADERS.SIGNATURE] === 'string';
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return null;
  const token = trimmed.slice(7).trim();
  if (token.length === 0) return null;
  return token;
}

function unauthorizedBody(): {
  readonly type: 'about:blank';
  readonly title: 'Unauthorized';
  readonly status: 401;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail: 'Authentication required.',
  };
}
