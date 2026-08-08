import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { GATEWAY_REDIS_TOKEN } from '../../../redis/redis.module';

/**
 * Phase-1 rate-limit policies (TS-140).
 *
 * - `default` — every authenticated route. CLAUDE.md §3.7 enforces
 *   Redis key namespacing; the gateway uses `{env}:gateway:rate-limit:
 *   {policy}:{actor}` keys exclusively.
 *
 * - `sensitive` — applied to surfaces that need a much tighter window
 *   per CLAUDE.md §3.1 (login circuit-breaker) and §12 (coupon abuse).
 *   In Phase 1 the gateway proxies very few sensitive routes, but the
 *   policy slot exists so adding /login or /coupons later is a one-
 *   line decorator change.
 *
 * Adding a third policy is additive: extend the union below + pull
 * window / max settings from a new env pair.
 */
export type RateLimitPolicy = 'default' | 'sensitive';

/**
 * Result returned by `RateLimitService.consume` — the decision the
 * caller renders into either a 200-path proceed or a 429 response.
 *
 * `allowed` is the only field consumers strictly need; `remaining` is
 * surfaced as a `RateLimit-Remaining` header for client back-pressure
 * (TS-140-followup) and `retryAfterSeconds` populates `Retry-After` on
 * a 429.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly limit: number;
  readonly retryAfterSeconds: number;
  readonly windowSeconds: number;
  /**
   * `unavailable: true` ⇒ Redis failed; the service is FAIL-OPEN per
   * CLAUDE.md §4.3 "caches are best-effort: code must work correctly
   * when Redis is unavailable" + §3.1 IP-level circuit-breaker is
   * supplementary defence-in-depth (the per-user lockout in
   * service-identity already gates the auth surface independently).
   */
  readonly unavailable: boolean;
}

/**
 * Sliding-window rate limiter backed by Redis sorted sets.
 *
 * Algorithm (executed atomically via Lua):
 *
 *   1. `ZREMRANGEBYSCORE key 0 (nowMs - windowMs)` — prune stale.
 *   2. `ZCARD key` — current count (post-prune).
 *   3. If `count < max` → `ZADD key nowMs nowNonce` + `EXPIRE key
 *      windowSeconds` and return `{ allowed=true, remaining=max-count-1 }`.
 *   4. If `count ≥ max` → return `{ allowed=false, remaining=0,
 *      retryAfterSeconds=ceil((oldestExpiry - now) / 1000) }` (the
 *      oldest entry's score + window is when the next slot opens up).
 *
 * Why sorted sets rather than fixed-window counters? Fixed windows
 * leak (a burst at the boundary doubles the effective limit for one
 * second). Sorted sets give a true sliding window with O(log N) per
 * insert, bounded by `max` (the largest the set can ever grow before
 * a rejection). For typical Phase-1 ceilings (max=120 / window=60s),
 * each key holds at most 120 entries.
 *
 * Per-key TTL: `EXPIRE key windowSeconds` after each `ZADD` so the
 * key self-cleans when idle. Keeps the Redis memory footprint bounded
 * regardless of the active-actor cardinality.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(GATEWAY_REDIS_TOKEN) private readonly redis: Redis,
  ) {}

  /**
   * Consume one slot for `(policy, actorKey)`. Returns the decision;
   * caller renders 200-path or 429.
   *
   * `actorKey` is the gateway-resolved actor identifier — `user:${id}`
   * for authenticated callers, `ip:${remoteAddr}` for anonymous ones.
   * Mixing the two in the same Redis key is intentional: the policy is
   * per logical actor, not per access path.
   */
  async consume(
    policy: RateLimitPolicy,
    actorKey: string,
    now: Date = new Date(),
  ): Promise<RateLimitDecision> {
    const limit = this.maxForPolicy(policy);
    const windowSeconds = this.windowForPolicy(policy);
    const key = formatRateLimitKey({
      environment: this.env.NODE_ENV,
      policy,
      actorKey,
    });

    const nowMs = now.getTime();
    const windowMs = windowSeconds * 1000;
    // Composite member: timestamp + per-call nonce so collisions
    // (two requests arriving within the same ms) don't dedupe under
    // ZADD's "score+member" uniqueness.
    const nonce = `${nowMs.toString(16)}-${(this.counter++).toString(16)}`;

    let raw: unknown;
    try {
      raw = await this.redis.eval(
        SLIDING_WINDOW_SCRIPT,
        1,
        key,
        nowMs.toString(),
        windowMs.toString(),
        limit.toString(),
        nonce,
        windowSeconds.toString(),
      );
    } catch (err) {
      this.logger.warn(
        {
          policy,
          actorKey,
          err: err instanceof Error ? err.message : 'unknown',
        },
        'rate-limit script failed; failing open',
      );
      return {
        allowed: true,
        remaining: limit,
        limit,
        retryAfterSeconds: 0,
        windowSeconds,
        unavailable: true,
      };
    }

    const parsed = parseScriptResult(raw);
    if (parsed === null) {
      this.logger.warn(
        { policy, actorKey, raw: JSON.stringify(raw) },
        'rate-limit script returned malformed payload; failing open',
      );
      return {
        allowed: true,
        remaining: limit,
        limit,
        retryAfterSeconds: 0,
        windowSeconds,
        unavailable: true,
      };
    }

    return {
      allowed: parsed.allowed === 1,
      remaining: Math.max(0, parsed.remaining),
      limit,
      retryAfterSeconds: parsed.retryAfterSeconds,
      windowSeconds,
      unavailable: false,
    };
  }

  private counter = 0;

  private maxForPolicy(policy: RateLimitPolicy): number {
    return policy === 'sensitive'
      ? this.env.RATE_LIMIT_SENSITIVE_MAX_REQUESTS
      : this.env.RATE_LIMIT_DEFAULT_MAX_REQUESTS;
  }

  private windowForPolicy(policy: RateLimitPolicy): number {
    return policy === 'sensitive'
      ? this.env.RATE_LIMIT_SENSITIVE_WINDOW_SECONDS
      : this.env.RATE_LIMIT_DEFAULT_WINDOW_SECONDS;
  }
}

/**
 * Build the Redis key for `(policy, actor)`. CLAUDE.md §3.7 mandates
 * the `{env}:{service}:{purpose}:{tenant?}:{id}` prefix shape.
 *
 * Exported so unit tests can assert the key shape directly.
 */
export function formatRateLimitKey(parts: {
  readonly environment: string;
  readonly policy: RateLimitPolicy;
  readonly actorKey: string;
}): string {
  return `${parts.environment}:gateway:rate-limit:${parts.policy}:${parts.actorKey}`;
}

interface ScriptResult {
  readonly allowed: 0 | 1;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

function parseScriptResult(raw: unknown): ScriptResult | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [allowedRaw, remainingRaw, retryRaw] = raw;
  const allowed = toInt(allowedRaw);
  const remaining = toInt(remainingRaw);
  const retry = toInt(retryRaw);
  if (allowed === null || remaining === null || retry === null) return null;
  if (allowed !== 0 && allowed !== 1) return null;
  return { allowed, remaining, retryAfterSeconds: retry };
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Atomic sliding-window check + record. Returns `{allowed, remaining,
 * retryAfterSeconds}` as a 3-element array (Redis Lua's native tuple
 * shape).
 *
 * KEYS[1] — the sorted-set key
 * ARGV[1] — now (epoch ms)
 * ARGV[2] — window (ms)
 * ARGV[3] — limit (max allowed in window)
 * ARGV[4] — nonce for ZADD member uniqueness
 * ARGV[5] — TTL seconds (== window seconds)
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local nonce = ARGV[4]
local ttl_seconds = tonumber(ARGV[5])

local window_start = now_ms - window_ms
redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now_ms, nonce)
  redis.call('EXPIRE', key, ttl_seconds)
  return {1, limit - count - 1, 0}
end

-- At capacity. Look up the oldest entry's score so we can report
-- when the next slot opens up. ZRANGE … WITHSCORES returns
-- [member, score] flat — we want only the score (index 2).
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry_after = ttl_seconds
if oldest and oldest[2] then
  local oldest_score = tonumber(oldest[2])
  local remaining_ms = (oldest_score + window_ms) - now_ms
  if remaining_ms > 0 then
    retry_after = math.ceil(remaining_ms / 1000)
  else
    retry_after = 0
  end
end
return {0, 0, retry_after}
`;
