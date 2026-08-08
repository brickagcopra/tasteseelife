import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import type { Request } from 'express';

import { TRUST_HEADER_OPTIONS_TOKEN } from './module/tokens';
import type { ValidatedTrustHeaderOptions } from './module/options';
import { verifyTrustHeaders, type VerifyTrustHeadersResult } from './verifier';

/**
 * NestJS guard that verifies the trust-header envelope minted by the
 * api-gateway and attaches the recovered `RequestContext` to the
 * request object so downstream code reads the same shape it would
 * have from a direct `verifyAccessToken` call.
 *
 * **Failure surface.** Every non-`ok` verifier result becomes a
 * generic HTTP 401 with a constant body — no oracle that distinguishes
 * "tampered envelope" from "expired envelope" from "missing envelope".
 * The verifier variant is recorded in a `warn` log line with PII-safe
 * labels so the operator can diagnose without leaking detail on the
 * wire.
 *
 * **Not the JWT guard.** This guard NEVER calls `verifyAccessToken`.
 * The api-gateway is the only place the JWT is verified; once a
 * request reaches a downstream service, the trust-header envelope is
 * the canonical actor identity. Direct callers (manual ops tools,
 * cluster-internal debuggers) that hit downstream service endpoints
 * without going through the gateway will fail this guard — that's
 * the intended behaviour: production traffic flows through the
 * gateway, and the NetworkPolicy (TS-151) further restricts who can
 * reach downstream service routes.
 *
 * **Trust headers vs. mTLS.** This guard is application-layer
 * defence-in-depth. mTLS (PDD §21.1, Phase 2) wraps every
 * service-to-service call in transport-layer encryption + mutual
 * authentication. NetworkPolicy (TS-151) restricts in-cluster
 * reachability. Three layers ⇒ break two before the third is exposed.
 */
@Injectable()
export class TrustHeaderGuard implements CanActivate {
  private readonly logger = new Logger(TrustHeaderGuard.name);

  constructor(
    @Inject(TRUST_HEADER_OPTIONS_TOKEN)
    private readonly options: ValidatedTrustHeaderOptions,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithContext>();
    const result = verifyTrustHeaders(request.headers, {
      signingSecret: this.options.signingSecret,
      maxAgeSeconds: this.options.maxAgeSeconds,
      futureToleranceSeconds: this.options.futureToleranceSeconds,
    });

    if (result.kind !== 'ok') {
      this.logFailure(result);
      throw new UnauthorizedException(unauthorizedBody());
    }

    request.requestContext = result.actor;
    return true;
  }

  private logFailure(result: Exclude<VerifyTrustHeadersResult, { kind: 'ok' }>): void {
    // Label-only logging. The header values themselves are NOT
    // logged — they may carry a (legitimately-signed) PII-bearing
    // actor identity that the logger redactor cannot see at this
    // layer. The verifier variant tells the operator which check
    // failed; the upstream gateway logs the actor for genuine traffic.
    switch (result.kind) {
      case 'missing_header':
        this.logger.warn(`trust-header verification failed: missing_header=${result.header}`);
        return;
      case 'unknown_version':
        this.logger.warn(`trust-header verification failed: unknown_version`);
        return;
      case 'timestamp_expired':
        this.logger.warn(
          `trust-header verification failed: timestamp_expired age=${result.ageSeconds}s`,
        );
        return;
      case 'timestamp_in_future':
        this.logger.warn(
          `trust-header verification failed: timestamp_in_future skew=${result.skewSeconds}s`,
        );
        return;
      default:
        this.logger.warn(`trust-header verification failed: ${result.kind}`);
    }
  }
}

export interface RequestWithContext extends Request {
  requestContext?: RequestContext;
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
