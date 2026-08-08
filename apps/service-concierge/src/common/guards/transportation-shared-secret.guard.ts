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
 * Constant-time shared-secret guard for the internal transportation
 * ride-status webhook (TS-226).
 *
 * A ride-hailing vendor (Uber Health / Lyft Health, Phase 3) POSTs ride-status
 * events to `POST /internal/concierge/transportation/ride-events`. The vendor
 * presents a header (default `x-concierge-transportation-internal-api-key`,
 * configurable via `CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME`) whose value
 * must match `CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY`. Both sides of the
 * comparison are byte-padded to the same length before `timingSafeEqual` to
 * avoid timing leaks on length mismatch.
 *
 * **Fail-closed.** When the env key is unset — the Phase-1 default, since every
 * ride runs on the `manual` provider and no vendor POSTs events yet — the guard
 * rejects EVERY request with a 401. A security gate degrades closed (unlike the
 * best-effort PagerDuty page in the emergency module, which degrades open). The
 * endpoint only opens once the Uber Health / Lyft Health integration configures
 * the secret (TS-226-followup).
 *
 * NetworkPolicy (TS-151) will restrict the route to in-cluster callers; this
 * guard is application-layer defence-in-depth (CLAUDE.md §3.5). Mirrors the
 * structure of service-provider's `ProviderDiscoverySharedSecretGuard` — the
 * shape is duplicated rather than lifted because each consumer-side env binding
 * is service-local (a shared `packages/nest-internal-secret` package can land
 * when a third service needs the same shape; the same lift-after-third-consumer
 * discipline applied to `PermissionGuard`).
 */
@Injectable()
export class TransportationSharedSecretGuard implements CanActivate {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.env.CONCIERGE_TRANSPORTATION_INTERNAL_API_KEY;
    // Fail closed: an unconfigured secret means the webhook is not yet
    // enabled — reject rather than wave the request through.
    if (expected === undefined || expected.length === 0) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    const request = context.switchToHttp().getRequest<Request>();
    const headerName = this.env.CONCIERGE_TRANSPORTATION_INTERNAL_HEADER_NAME.toLowerCase();
    const supplied = request.headers[headerName];

    if (typeof supplied !== 'string' || supplied.length === 0) {
      throw new UnauthorizedException(unauthorizedBody());
    }

    if (!constantTimeStringEqual(supplied, expected)) {
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
