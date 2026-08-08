import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { RbacModule } from '../rbac/rbac.module';
import { AuthController } from './controllers/auth.controller';
import { EmailVerificationController } from './controllers/email-verification.controller';
import { MfaController } from './controllers/mfa.controller';
import { AuthService } from './services/auth.service';
import { EmailVerificationEmitter } from './services/email-verification-emitter';
import { EmailVerificationService } from './services/email-verification.service';
import {
  IpCircuitBreakerService,
  LOGIN_IP_RATE_LIMIT_REDIS_TOKEN,
} from './services/ip-circuit-breaker.service';
import { LockoutService } from './services/lockout.service';
import { MfaChallengeTokenService } from './services/mfa-challenge-token.service';
import { MfaRecoveryCodeService } from './services/mfa-recovery-code.service';
import { MfaSecretCipherService } from './services/mfa-secret-cipher.service';
import { MfaService } from './services/mfa.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { RefreshTokenService } from './services/refresh-token.service';
import { TokenService } from './services/token.service';
import { TotpService } from './services/totp.service';
import {
  VerificationResendCooldownService,
  VERIFICATION_RESEND_REDIS_TOKEN,
} from './services/verification-resend-cooldown.service';
import { VerificationTokenPruneService } from './services/verification-token-prune.service';
import { VerificationTokenPruneRunner } from './verification-token-prune.runner';

/**
 * Auth bounded module — owns signup (TS-021), login + refresh
 * (TS-022), TOTP MFA enrollment + verification (TS-023), RBAC-aware
 * access tokens (TS-024), per-user failed-login lockout (TS-025),
 * the IP-level circuit breaker complement (TS-025-followup-1),
 * email verification (TS-510 — the flip from `pending_verification` to
 * `active` that signup had no counterpart for), and
 * (in subsequent tasks) KYC (TS-026).
 *
 * Imports `RbacModule` so `AuthService.issueSessionFor` can pull the
 * caller's active role assignments at session-issue time and bake them
 * into the access token's `roles` claim (CLAUDE.md §3.2).
 *
 * **Redis client.** The IP circuit breaker (TS-025-followup-1) needs
 * a dedicated ioredis client — same posture as `CouponsModule` /
 * `IdempotencyModule`: separate connection pool so a breaker INCR
 * storm during a credential-stuffing attack cannot starve the
 * idempotency-cache hot path. Both clients connect to the same
 * `REDIS_URL` so cluster-side semantics are identical. The client is
 * fail-fast (`enableOfflineQueue: false`, `maxRetriesPerRequest: 1`)
 * so a Redis outage surfaces as a swallowed exception in the
 * breaker — the service then fails open per CLAUDE.md §4.3.
 *
 * `OnApplicationShutdown` quits the client on Nest shutdown so the
 * connection drains cleanly under Kubernetes pod-termination. Same
 * lifecycle pattern as `CouponsModule`.
 *
 * Exports `AuthService` and `PasswordHasherService` so future cross-
 * module flows (admin password reset, MFA enrollment) can reuse them
 * without a module refactor. `TokenService`, `RefreshTokenService`,
 * `TotpService`, `MfaService`, `MfaSecretCipherService`,
 * `MfaChallengeTokenService`, `LockoutService`, and
 * `IpCircuitBreakerService` are exported because admin / audit
 * surfaces will reuse them for session, MFA, lockout, and breaker
 * management features.
 */
@Module({
  imports: [RbacModule],
  controllers: [AuthController, EmailVerificationController, MfaController],
  providers: [
    AuthService,
    EmailVerificationService,
    EmailVerificationEmitter,
    PasswordHasherService,
    TokenService,
    RefreshTokenService,
    TotpService,
    MfaSecretCipherService,
    MfaChallengeTokenService,
    MfaRecoveryCodeService,
    MfaService,
    LockoutService,
    IpCircuitBreakerService,
    VerificationResendCooldownService,
    VerificationTokenPruneService,
    VerificationTokenPruneRunner,
    {
      // TS-510-followup-3. Its OWN client rather than sharing the breaker's:
      // both run with `enableOfflineQueue: false`, so a shared connection
      // would make a stall on one guard a stall on the other, and the
      // connection name is what an operator greps in `CLIENT LIST`.
      provide: VERIFICATION_RESEND_REDIS_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Redis =>
        new Redis(env.REDIS_URL, {
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          lazyConnect: false,
          keyPrefix: '',
          connectionName: 'service-identity-verification-resend-cooldown',
        }),
    },
    {
      provide: LOGIN_IP_RATE_LIMIT_REDIS_TOKEN,
      inject: [ENV_TOKEN],
      useFactory: (env: Env): Redis =>
        new Redis(env.REDIS_URL, {
          // Same posture as IdempotencyModule's client: fail-fast
          // instead of queuing commands when Redis is down (CLAUDE.md
          // §4.3 — caches best-effort).
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          lazyConnect: false,
          keyPrefix: '',
          // Connection name surfaces in `CLIENT LIST` for ops triage.
          connectionName: 'service-identity-login-ip-circuit-breaker',
        }),
    },
  ],
  exports: [
    AuthService,
    EmailVerificationService,
    PasswordHasherService,
    TokenService,
    RefreshTokenService,
    TotpService,
    MfaSecretCipherService,
    MfaChallengeTokenService,
    MfaRecoveryCodeService,
    MfaService,
    LockoutService,
    IpCircuitBreakerService,
  ],
})
export class AuthModule implements OnApplicationShutdown {
  constructor(
    @Inject(LOGIN_IP_RATE_LIMIT_REDIS_TOKEN) private readonly ipCircuitBreakerRedis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.ipCircuitBreakerRedis.status !== 'end') {
      await this.ipCircuitBreakerRedis.quit().catch(() => {
        /* swallow — pod is going away */
      });
    }
  }
}
