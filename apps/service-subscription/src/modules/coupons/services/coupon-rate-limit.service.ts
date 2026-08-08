import { createHash } from 'crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { err, ok, type Result } from '../../subscriptions/result';

/** DI token for the rate-limiter's dedicated ioredis client. */
export const COUPON_RATE_LIMIT_REDIS_TOKEN = 'COUPON_RATE_LIMIT_REDIS' as const;

/**
 * Failure shapes for the rate-limit gate. `rate_limited` is the
 * dominant negative path; `unavailable` surfaces Redis outages so
 * the controller can choose to fail open (default) or fail closed.
 */
export type CouponRateLimitFailure =
  | {
      readonly reason: 'rate_limited';
      readonly scope: 'ip' | 'user';
      readonly retryAfterSeconds: number;
      readonly limit: number;
      readonly windowSeconds: number;
    }
  | { readonly reason: 'unavailable'; readonly cause: unknown };

export interface CouponRateLimitCheckInput {
  /** Source IP captured by the controller (request.ip). */
  readonly ip: string;
  /** Authenticated user id. Required because the validate endpoint
   *  sits behind AccessTokenGuard. */
  readonly userId: string;
}

/**
 * `CouponRateLimitService` (TS-043) — Redis-backed sliding-window
 * abuse guard for the `POST /api/v1/coupons/validate` endpoint
 * (CLAUDE.md §12 "rate-limit coupon attempts per IP and per account").
 *
 * **Algorithm**: fixed-window counter with two parallel buckets, one
 * keyed on the source IP and one keyed on the authenticated user id.
 * Each bucket is a Redis key of the shape:
 *
 *   {env}:service-subscription:coupon-rate:{scope}:{value}:{epoch_window}
 *
 * Per CLAUDE.md §3.7 — keys carry the env + service + purpose + scope
 * tuple so no two callers' counters can collide. The window is a
 * floor-divided epoch second (e.g. `floor(now / 60)` for a 60-second
 * window), so the bucket auto-rolls every window without an explicit
 * scheduler. We `INCR` + `EXPIRE` atomically; the EXPIRE is a no-op
 * after the first call but keeps the key TTLd against the cluster
 * (CLAUDE.md §4.3 — TTL on every Redis key).
 *
 * **Fail-open posture**. Redis outages return `unavailable` and the
 * controller proceeds (CLAUDE.md §4.3: "Caches are best-effort: code
 * must work correctly when Redis is unavailable"). The eligibility
 * gate on the coupon itself stays authoritative.
 *
 * **No client info logged** beyond hashes (`redactValue`) so the IP
 * + userId never land in the structured log stream (CLAUDE.md §3.9 —
 * never log PII unredacted).
 *
 * The fixed-window approach is intentionally simple. A sliding-window
 * log (sorted-set ZADD/ZREMRANGEBYSCORE) is more accurate at the
 * window boundary but materially heavier; the fixed-window false-
 * positive at the boundary is acceptable for an abuse guard whose
 * limits are conservative.
 */
@Injectable()
export class CouponRateLimitService {
  private readonly logger = new Logger(CouponRateLimitService.name);
  private readonly keyPrefix: string;
  private readonly ipLimit: number;
  private readonly ipWindowSeconds: number;
  private readonly userLimit: number;
  private readonly userWindowSeconds: number;

  constructor(
    @Inject(ENV_TOKEN) env: Env,
    @Inject(COUPON_RATE_LIMIT_REDIS_TOKEN) private readonly redis: Redis,
  ) {
    this.keyPrefix = `${env.NODE_ENV}:service-subscription:coupon-rate`;
    this.ipLimit = env.COUPON_RATE_LIMIT_IP_MAX_PER_WINDOW;
    this.ipWindowSeconds = env.COUPON_RATE_LIMIT_IP_WINDOW_SECONDS;
    this.userLimit = env.COUPON_RATE_LIMIT_USER_MAX_PER_WINDOW;
    this.userWindowSeconds = env.COUPON_RATE_LIMIT_USER_WINDOW_SECONDS;
  }

  /**
   * Check whether a coupon-validate attempt from this caller is allowed.
   *
   * Increments both buckets unconditionally — calling code shouldn't
   * skip the increment on the failure path, otherwise a determined
   * caller could just always re-try until one of the windows lapses.
   * The successful return only happens when BOTH buckets are under
   * the cap; otherwise the first crossing bucket short-circuits.
   *
   * `retryAfterSeconds` is the number of seconds until the offending
   * window rolls — useful for the controller's `Retry-After` header.
   */
  async check(input: CouponRateLimitCheckInput): Promise<Result<void, CouponRateLimitFailure>> {
    const nowSeconds = Math.floor(Date.now() / 1000);

    try {
      const [ipCount, ipExpiresIn] = await this.incrementBucket(
        'ip',
        input.ip,
        nowSeconds,
        this.ipWindowSeconds,
      );
      if (ipCount > this.ipLimit) {
        return err({
          reason: 'rate_limited',
          scope: 'ip',
          retryAfterSeconds: Math.max(ipExpiresIn, 1),
          limit: this.ipLimit,
          windowSeconds: this.ipWindowSeconds,
        });
      }

      const [userCount, userExpiresIn] = await this.incrementBucket(
        'user',
        input.userId,
        nowSeconds,
        this.userWindowSeconds,
      );
      if (userCount > this.userLimit) {
        return err({
          reason: 'rate_limited',
          scope: 'user',
          retryAfterSeconds: Math.max(userExpiresIn, 1),
          limit: this.userLimit,
          windowSeconds: this.userWindowSeconds,
        });
      }

      return ok(undefined);
    } catch (cause) {
      this.logger.warn(
        { err: redisErrorMessage(cause) },
        'coupon-rate-limit redis unavailable; failing open',
      );
      return err({ reason: 'unavailable', cause });
    }
  }

  /**
   * INCR + EXPIRE the bucket. Returns the post-increment count and
   * the seconds remaining until the window rolls. Uses `EXPIRE NX`
   * semantics by checking `TTL` after the INCR — Redis 7 has
   * EXPIRE...NX directly but pinning to the basic primitive keeps
   * compatibility with the older clusters dev-test still uses.
   */
  private async incrementBucket(
    scope: 'ip' | 'user',
    value: string,
    nowSeconds: number,
    windowSeconds: number,
  ): Promise<[count: number, expiresInSeconds: number]> {
    const window = Math.floor(nowSeconds / windowSeconds);
    const key = `${this.keyPrefix}:${scope}:${redactValue(value)}:${window}`;

    const pipeline = this.redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, windowSeconds);
    const results = await pipeline.exec();

    if (results === null || results.length === 0) {
      throw new Error('redis pipeline returned no results');
    }
    const incrEntry = results[0];
    if (!Array.isArray(incrEntry) || incrEntry[0] !== null) {
      throw incrEntry?.[0] ?? new Error('redis INCR failed');
    }
    const count = Number(incrEntry[1]);
    if (Number.isNaN(count)) {
      throw new Error('redis INCR returned non-numeric value');
    }

    const expiresInSeconds = (window + 1) * windowSeconds - nowSeconds;
    return [count, expiresInSeconds];
  }
}

/**
 * Hash the raw IP / userId into a short digest before it lands in a
 * Redis key. Avoids putting customer-identifying data in keys that
 * may be inspected by ops via `MONITOR` or `SLOWLOG`. Truncated SHA-256
 * for storage compactness — collisions are tolerable at this
 * cardinality (the bucket counts a few hundred values at most).
 */
function redactValue(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function redisErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown redis error';
}
