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
 * Constant-time shared-secret guard for the internal billing-contacts
 * endpoint (TS-042-followup-3a1a).
 *
 * service-notification's dunning ladder sends a header (default
 * `x-provider-billing-contacts-internal-api-key`, configurable via
 * `PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME`) whose value must match
 * `PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY`.
 *
 * **Its own secret, not `ProviderDiscoverySharedSecretGuard`'s** — see the
 * env doc-block. Different caller, different trust principal.
 *
 * Structurally identical to that guard, and that duplication is now at
 * three copies on this service (background-check webhook, discovery, this).
 * The lift to a shared `packages/nest-internal-secret` is the standing
 * rule-of-three trigger and is filed as TS-042-followup-3a1a-followup-1
 * rather than done inline, because the consumer-side env binding is
 * service-local and the extraction is its own change.
 */
@Injectable()
export class ProviderBillingContactsSharedSecretGuard implements CanActivate {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const headerName = this.env.PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME.toLowerCase();
    const supplied = request.headers[headerName];

    if (typeof supplied !== 'string' || supplied.length === 0) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    if (!constantTimeStringEqual(supplied, this.env.PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY)) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    return true;
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
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
