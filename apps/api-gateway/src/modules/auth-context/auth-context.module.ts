import { Module } from '@nestjs/common';

import { AuthContextSignerService } from './services/auth-context-signer.service';

/**
 * Trust-header signing module (TS-140).
 *
 * Exports `AuthContextSignerService` so any downstream-call module
 * (proxy controllers, aggregation services) can mint the trust-header
 * envelope from the verified `RequestContext` the AccessTokenGuard
 * attached to the request.
 *
 * The signing primitives themselves live in
 * `@taste-and-see/nest-internal-trust` so the downstream
 * `TrustHeaderGuard` recomputes the same canonical input + HMAC.
 * `AuthContextSignerService` is the gateway-side DI wrapper that
 * binds the signing secret from `Env`.
 */
@Module({
  providers: [AuthContextSignerService],
  exports: [AuthContextSignerService],
})
export class AuthContextModule {}
