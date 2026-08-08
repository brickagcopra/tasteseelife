import { createHash } from 'crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Counter, getMeter, withSpan } from '@taste-and-see/tracing';
import type { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/** DI token for the cooldown's dedicated ioredis client. */
export const VERIFICATION_RESEND_REDIS_TOKEN = 'VERIFICATION_RESEND_REDIS' as const;

/** Outcome of a `claim` — emitted as a metric and a span attribute. */
type ClaimOutcome = 'allowed' | 'cooled_down' | 'unavailable';

/**
 * `VerificationResendCooldownService` (TS-510-followup-3) — a per-address
 * cooldown on `POST /api/v1/auth/verification-emails`.
 *
 * **The threat is not the account, it is the inbox.** Every other abuse
 * guard on this service protects the account being attacked; this one
 * protects a person who may have nothing to do with the platform. The
 * address on that request is attacker-chosen, so the endpoint is a lever
 * for mailing a stranger repeatedly, in our name, from our sending
 * domain. It became a live lever the moment TS-510-followup-4 landed the
 * consumer that actually sends the mail — before that, the endpoint
 * appended outbox rows nobody drained.
 *
 * The gateway's `sensitive` per-IP policy already stops one host
 * hammering it. It does nothing about a distributed caller aiming many
 * hosts at one address, which is the shape that matters here: the limit
 * has to be keyed on the **target**, not on the source.
 *
 * **The response must not change.** `resend` returns 202 for every
 * address the schema accepts — registered, unregistered, already verified
 * — because distinguishing them is an account-enumeration oracle
 * (TS-510). A cooldown that answered 429 would reintroduce exactly that
 * oracle in a new place: "this address is cooling down" means "somebody
 * asked about this address recently", which for a registered address is a
 * far more interesting signal than the original. So a cooled-down request
 * mints nothing and returns the same 202 through the same path.
 *
 * **Claimed BEFORE the account lookup**, deliberately. That makes the
 * cooldown apply uniformly to addresses with no account, which keeps the
 * timing profile flat and stops the endpoint being used to probe the user
 * table at all. The cost is that a request for a non-existent address
 * consumes the window for that address — which is the same outcome the
 * cooldown exists to produce.
 *
 * **The key is a hash of the address**, per CLAUDE.md §3.7. An unhashed
 * key would make Redis a browsable list of addresses that recently
 * requested verification — i.e. a list of new customers — readable by
 * anything with `KEYS` on the cluster.
 *
 * **Fail-open on a Redis outage**, matching `IpCircuitBreakerService` and
 * CLAUDE.md §4.3 ("code must work correctly when Redis is unavailable").
 * The trade is deliberate and worth naming: during an outage the mail-bomb
 * works, bounded by the gateway's per-IP policy. The alternative —
 * failing closed — means nobody on the platform can get a verification
 * email while Redis is down, which breaks signup for every legitimate
 * customer to inconvenience an attacker who is not currently attacking.
 * The `unavailable` outcome is metered so the window is visible rather
 * than merely survivable.
 */
@Injectable()
export class VerificationResendCooldownService {
  private readonly logger = new Logger(VerificationResendCooldownService.name);
  private readonly keyPrefix: string;
  private readonly cooldownSeconds: number;
  private readonly claimCounter: Counter;

  constructor(
    @Inject(ENV_TOKEN) env: Env,
    @Inject(VERIFICATION_RESEND_REDIS_TOKEN) private readonly redis: Redis,
  ) {
    this.keyPrefix = `${env.NODE_ENV}:service-identity:verify-resend`;
    this.cooldownSeconds = env.VERIFICATION_RESEND_COOLDOWN_SECONDS;

    const meter = getMeter('service-identity:verification-resend-cooldown');
    this.claimCounter = meter.createCounter('verification_resend_cooldown_total', {
      description:
        'Verification-resend cooldown decisions, by outcome (allowed / cooled_down / unavailable).',
    });
  }

  /**
   * Try to claim the window for `email`. `true` means go ahead and mint;
   * `false` means a request for this address landed inside the cooldown
   * and this one must do nothing.
   *
   * `SET key 1 EX <window> NX` is the whole algorithm: atomic, one round
   * trip, and self-expiring so nothing has to sweep it (CLAUDE.md §4.3 —
   * TTL on every key). The TTL is NOT refreshed by a blocked attempt, so
   * a flood cannot extend a legitimate user's wait indefinitely.
   *
   * The caller must have normalised the address already — the cooldown
   * has to key on the same string the account lookup does, or `A@x.com`
   * and `a@x.com` get separate windows for one inbox.
   */
  async claim(normalisedEmail: string): Promise<boolean> {
    return withSpan('verification-resend-cooldown.claim', async (span) => {
      const emailHash = hashEmail(normalisedEmail);
      span.setAttribute('cooldown.email_hash', emailHash);
      span.setAttribute('cooldown.window_seconds', this.cooldownSeconds);

      let outcome: ClaimOutcome;
      let allowed: boolean;
      try {
        const result = await this.redis.set(
          `${this.keyPrefix}:${emailHash}`,
          '1',
          'EX',
          this.cooldownSeconds,
          'NX',
        );
        allowed = result !== null;
        outcome = allowed ? 'allowed' : 'cooled_down';
      } catch (cause) {
        // Never the address, never the hash-free value — and never the
        // raw error object, which ioredis populates with the command
        // arguments (i.e. the key) on some failure paths.
        this.logger.warn(
          { err: errorMessage(cause) },
          'verification-resend cooldown unavailable — failing open',
        );
        outcome = 'unavailable';
        allowed = true;
      }

      span.setAttribute('cooldown.outcome', outcome);
      this.claimCounter.add(1, { outcome });
      return allowed;
    });
  }
}

/**
 * Truncated SHA-256, matching `IpCircuitBreakerService.hashIp`. 16 hex
 * characters is 64 bits — collisions are irrelevant here (a collision
 * costs one stranger a one-minute wait) and the digest is not reversible
 * to an address by anyone reading the keyspace.
 */
function hashEmail(email: string): string {
  return createHash('sha256').update(email).digest('hex').slice(0, 16);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'unknown redis error';
}
