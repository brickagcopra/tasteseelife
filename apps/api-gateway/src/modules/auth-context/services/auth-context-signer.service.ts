import { Inject, Injectable } from '@nestjs/common';
import type { RequestContext } from '@taste-and-see/auth-sdk';
import {
  TRUST_HEADERS,
  TRUST_HEADER_VERSION,
  buildCanonicalInput,
  signTrustHeaders,
  type TrustHeaders,
} from '@taste-and-see/nest-internal-trust';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * Mint the signed trust-header envelope that propagates the gateway-
 * verified actor identity to a downstream service.
 *
 * Thin DI wrapper around `signTrustHeaders` from
 * `@taste-and-see/nest-internal-trust`. The shared package owns the
 * canonical input + signing logic; the gateway-side service exists
 * solely to bind the signing secret from this app's `Env`.
 *
 * Symmetric verifier: the downstream services consume the same
 * shared package's `TrustHeaderGuard` + `verifyTrustHeaders`. Because
 * both sides import `buildCanonicalInput` + `TRUST_HEADERS` from the
 * same source, a future change to the canonical input shape bumps
 * `TRUST_HEADER_VERSION` and breaks producer + verifier together —
 * the silent-drift failure mode is eliminated by construction.
 *
 * **Not a substitute for NetworkPolicy / mTLS.** The trust headers
 * are application-layer defence-in-depth. NetworkPolicy (TS-151)
 * restricts the routes to in-cluster callers; mTLS (PDD §21.1,
 * Phase 2) wraps everything in transport-layer encryption + mutual
 * authentication. Three layers ⇒ break two before the third is
 * exposed.
 */
@Injectable()
export class AuthContextSignerService {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  sign(actor: RequestContext, now: Date = new Date()): TrustHeaders {
    return signTrustHeaders(actor, {
      signingSecret: this.env.INTERNAL_TRUST_SIGNING_SECRET,
      now,
    });
  }
}

/**
 * Re-export the canonical wire-format constants + helpers so the
 * existing gateway-side test suite + any in-app code that consumed
 * them from this module continues to work after the lift to
 * `@taste-and-see/nest-internal-trust`.
 *
 * New consumers should import directly from
 * `@taste-and-see/nest-internal-trust` instead of going through this
 * service.
 */
export { TRUST_HEADERS, TRUST_HEADER_VERSION, buildCanonicalInput };
export type { TrustHeaders };
