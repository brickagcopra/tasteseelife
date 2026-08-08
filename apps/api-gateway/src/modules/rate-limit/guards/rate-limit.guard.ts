import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

import type { RequestWithContext } from '@taste-and-see/nest-auth';
import { RATE_LIMIT_METADATA, type RateLimitOptions } from '../decorators/rate-limit.decorator';
import { actorKindFromKey, RateLimitMetrics } from '../services/rate-limit-metrics';
import { RateLimitService, type RateLimitPolicy } from '../services/rate-limit.service';

/**
 * Per-request rate-limit gate. Reads the route's `@RateLimit({ policy })`
 * metadata (defaults to `'default'`), resolves the actor key (auth
 * context's userId if the upstream guard has set it; otherwise the
 * client IP), calls `RateLimitService.consume`, and either passes the
 * request through with informational rate-limit headers or throws
 * `HttpException(429)` with a `Retry-After` header.
 *
 * Wire order matters: this guard MUST run AFTER `AccessTokenGuard`
 * on protected routes so the actor key is per-user, not per-IP. On
 * public routes (login / signup) it runs alone and the actor key is
 * per-IP. Configure via controller-level guard ordering.
 *
 * Fail-open posture (CLAUDE.md §4.3): when Redis is unavailable the
 * service returns `{allowed: true, unavailable: true}` and this guard
 * passes the request through with an `X-Rate-Limit-Status: unavailable`
 * header so ops can dashboard the symptom without users seeing 429s.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly service: RateLimitService,
    private readonly metrics: RateLimitMetrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithContext>();
    const response = http.getResponse<Response>();

    const policy = this.resolvePolicy(context);
    const actorKey = resolveActorKey(request);

    const decision = await this.service.consume(policy, actorKey);

    // TS-140-followup-4 — recorded HERE rather than inside the service
    // because this is where the three outcomes become distinguishable: the
    // service returns `allowed: true` for both a real pass and a fail-open,
    // and only the `unavailable` flag separates them. `actorKey` is
    // classified into a bounded kind and never becomes a label itself.
    this.metrics.recordDecision(
      policy,
      decision.unavailable ? 'unavailable' : decision.allowed ? 'allowed' : 'blocked',
      actorKindFromKey(actorKey),
    );

    response.setHeader('X-RateLimit-Limit', decision.limit.toString());
    response.setHeader('X-RateLimit-Remaining', decision.remaining.toString());
    response.setHeader('X-RateLimit-Window-Seconds', decision.windowSeconds.toString());

    if (decision.unavailable) {
      response.setHeader('X-RateLimit-Status', 'unavailable');
      return true;
    }

    if (!decision.allowed) {
      response.setHeader('Retry-After', decision.retryAfterSeconds.toString());
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Too Many Requests',
          status: HttpStatus.TOO_MANY_REQUESTS,
          detail: 'Rate limit exceeded for this client. Retry after the window expires.',
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private resolvePolicy(context: ExecutionContext): RateLimitPolicy {
    const meta = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );
    return meta?.policy ?? 'default';
  }
}

/**
 * Resolve the actor key for rate-limit grouping.
 *
 * Priority:
 *   1. `request.requestContext.userId` — the authenticated actor, set
 *      by an upstream `AccessTokenGuard`. Per-user rate limit.
 *   2. The first hop of `X-Forwarded-For` (the WAF / Cloudflare / ALB
 *      sets this to the real client IP). Per-IP rate limit.
 *   3. `req.ip` from Express (parses `X-Forwarded-For` only when
 *      `trust proxy` is set; we set it on app bootstrap).
 *   4. The literal `'unknown'` — a placeholder so even completely
 *      header-less callers (curl + private network) still get a key.
 *      Collisions here are benign — every such caller shares one
 *      bucket per policy, which is exactly the desired behaviour for
 *      "no identity at all".
 */
export function resolveActorKey(request: RequestWithContext): string {
  const userId = request.requestContext?.userId;
  if (typeof userId === 'string' && userId.length > 0) {
    return `user:${userId}`;
  }
  const xff = pickFirstForwardedFor(request);
  if (xff !== null) return `ip:${xff}`;
  const expressIp = (request as Request).ip;
  if (typeof expressIp === 'string' && expressIp.length > 0) return `ip:${expressIp}`;
  return 'ip:unknown';
}

function pickFirstForwardedFor(request: Request): string | null {
  const header = request.headers['x-forwarded-for'];
  if (typeof header !== 'string') return null;
  const first = header.split(',')[0]?.trim();
  if (first === undefined || first.length === 0) return null;
  return first;
}
