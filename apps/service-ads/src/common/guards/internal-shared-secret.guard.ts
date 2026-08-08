import { timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

/**
 * Constant-time shared-secret guard for the internal sponsored-listings
 * resolve surface (TS-218a). The `service-search` delivery caller sends a
 * header (`x-internal-api-key` by default) whose value must match
 * `ADS_INTERNAL_API_KEY`. Both sides of the comparison are byte-padded to
 * the same length before `timingSafeEqual` to avoid timing leaks on length
 * mismatch.
 *
 * NetworkPolicy (TS-151) will restrict the route to in-cluster callers; this
 * guard is application-layer defence-in-depth (CLAUDE.md §3.5). Mirrors
 * service-search's `InternalSharedSecretGuard` one-to-one.
 */
@Injectable()
export class InternalSharedSecretGuard implements CanActivate {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const headerName = this.env.ADS_INTERNAL_HEADER_NAME.toLowerCase();
    const supplied = request.headers[headerName];

    if (typeof supplied !== 'string' || supplied.length === 0) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    if (!constantTimeStringEqual(supplied, this.env.ADS_INTERNAL_API_KEY)) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    return true;
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
  // Pad both to the same byte length so timingSafeEqual doesn't throw (and so
  // the length comparison itself doesn't leak). The byte-compare result is
  // AND'd with the actual length match so a longer supplied value can't slip
  // through.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  const len = Math.max(aBuf.length, bBuf.length);
  const aPadded = Buffer.alloc(len);
  const bPadded = Buffer.alloc(len);
  aBuf.copy(aPadded);
  bBuf.copy(bPadded);
  const bytesEqual = timingSafeEqual(aPadded, bPadded);
  return bytesEqual && aBuf.length === bBuf.length;
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
    detail: 'Internal authentication required.',
  };
}
