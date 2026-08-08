import { createHash } from 'crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Counter, getMeter, type Histogram, withSpan } from '@taste-and-see/tracing';
import type { Redis } from 'ioredis';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/** DI token for the breaker's dedicated ioredis client. */
export const LOGIN_IP_RATE_LIMIT_REDIS_TOKEN = 'LOGIN_IP_RATE_LIMIT_REDIS' as const;

/** Outcome of a `checkBlocked` evaluation — emitted as a metric + span attribute. */
type CheckOutcome = 'allowed' | 'blocked' | 'unavailable';

/** Outcome of a `recordFailure` write — emitted as a metric + span attribute. */
type RecordOutcome = 'incremented' | 'unavailable';

/** Which Redis operation a latency sample belongs to. */
type RedisOperation = 'check' | 'record';

/**
 * `IpCircuitBreakerService` (TS-025-followup-1) — Redis-backed
 * sliding-window circuit breaker per source IP × `/api/v1/auth/login`
 * that complements the per-user `LockoutService` (TS-025).
 *
 * **Threat model.** CLAUDE.md §3.1 names two tiers: per-user
 * exponential backoff AND an IP-level circuit breaker. The per-user
 * tier defends a single account against password guessing; the IP
 * tier defends the platform against credential stuffing — one
 * attacker probing many accounts from one IP hits the IP gate before
 * they hit any single user's per-user gate (which would only trigger
 * after 3+ failures against ONE account). Together the two layers
 * close the cross-account probing window the per-user gate alone
 * leaves open.
 *
 * **Algorithm.** Fixed-window counter, keyed on the source IP. Each
 * bucket is a Redis key of the shape:
 *
 *   {env}:service-identity:login-ip-rate:{ipHash}:{epoch_window}
 *
 * Per CLAUDE.md §3.7 — keys carry the env + service + purpose + scope
 * tuple so no two callers' counters can collide. The window is a
 * floor-divided epoch second (e.g. `floor(now / 300)` for a 5-minute
 * window) so the bucket auto-rolls every window without an explicit
 * scheduler. `recordFailure` INCRs + EXPIREs atomically via a
 * pipeline; the EXPIRE is a no-op after the first call but keeps the
 * key TTLd against the cluster (CLAUDE.md §4.3 — TTL on every Redis
 * key).
 *
 * The fixed-window approach is intentionally simple. A sliding-window
 * log (sorted-set ZADD/ZREMRANGEBYSCORE) is more accurate at the
 * window boundary but materially heavier; the fixed-window false-
 * positive at the boundary is acceptable for an abuse guard whose
 * threshold is conservative (30 failures / 5 min is well above any
 * legitimate-user retype rate).
 *
 * **Fail-open posture.** Redis outages return `false` (not blocked)
 * from `checkBlocked` and silently swallow errors in `recordFailure`
 * — CLAUDE.md §4.3: "Caches are best-effort: code must work
 * correctly when Redis is unavailable." The per-user `LockoutService`
 * stays authoritative; the breaker only adds an extra cross-account
 * layer.
 *
 * **PII discipline.** The raw IP never lands in a Redis key or a
 * structured log — `hashIp` truncates a SHA-256 digest to 16 hex
 * chars before storage. Collisions are tolerable at this cardinality
 * (the bucket counts at most a few thousand IPs per window before
 * the window rolls). CLAUDE.md §3.9 — never log PII unredacted.
 *
 * **Counting policy.** The AuthService records a failure on EVERY
 * credential-failure branch (no-user, soft-deleted, inactive-status,
 * bad-password). An attacker doesn't know which branch their probe
 * hit, so the breaker shouldn't either — otherwise a clever
 * adversary could craft probes that don't increment the breaker. The
 * per-user `LockoutService` is more selective (only `bad-password`
 * lands a counter increment, to avoid punishing a different account
 * when a user typos their email) — the two layers differ on purpose.
 *
 * **No oracle.** Once the breaker trips, login returns the same
 * generic 401 as bad-password — never "rate limited" or "try
 * again later" — so the breaker state itself is not enumerable.
 * The breaker just causes the no-user branch to fire universally.
 *
 * **Observability (TS-025-followup-1a; CLAUDE.md §10).** Both methods
 * run inside an OTel span (`ip-circuit-breaker.check` /
 * `ip-circuit-breaker.record`) so the breaker decision shows up as a
 * logical operation in traces, with the auto-instrumented ioredis
 * GET / INCR as child spans. Three Prometheus instruments are exposed
 * on the service `/metrics` endpoint:
 *
 *   - `login_ip_circuit_breaker_check_total{outcome=allowed|blocked|unavailable}`
 *   - `login_ip_circuit_breaker_record_total{outcome=incremented|unavailable}`
 *   - `login_ip_circuit_breaker_redis_duration_seconds{operation=check|record}` (histogram)
 *
 * PII discipline holds at the metric-label level too: the labels are
 * RESTRICTED to `outcome` / `operation` — the IP (raw OR hashed) never
 * lands on a metric label, so the metric cardinality stays bounded and
 * no customer-identifying data leaks into the scrape surface. The
 * hashed IP rides only on the span attribute (`breaker.ip_hash`) and
 * the structured warn logs. The instruments bind to the global
 * MeterProvider at construction — when metrics are not initialized
 * (unit tests, CLI scripts) `getMeter` returns a no-op meter, so the
 * `.add` / `.record` calls are harmless no-ops and the fail-open
 * behaviour is unchanged.
 */
@Injectable()
export class IpCircuitBreakerService {
  private readonly logger = new Logger(IpCircuitBreakerService.name);
  private readonly keyPrefix: string;
  private readonly maxPerWindow: number;
  private readonly windowSeconds: number;
  private readonly checkCounter: Counter;
  private readonly recordCounter: Counter;
  private readonly redisDurationHistogram: Histogram;

  constructor(
    @Inject(ENV_TOKEN) env: Env,
    @Inject(LOGIN_IP_RATE_LIMIT_REDIS_TOKEN) private readonly redis: Redis,
  ) {
    this.keyPrefix = `${env.NODE_ENV}:service-identity:login-ip-rate`;
    this.maxPerWindow = env.LOGIN_IP_RATE_LIMIT_MAX_PER_WINDOW;
    this.windowSeconds = env.LOGIN_IP_RATE_LIMIT_WINDOW_SECONDS;

    const meter = getMeter('service-identity:ip-circuit-breaker');
    this.checkCounter = meter.createCounter('login_ip_circuit_breaker_check_total', {
      description:
        'Login IP circuit-breaker check decisions, by outcome (allowed / blocked / unavailable).',
    });
    this.recordCounter = meter.createCounter('login_ip_circuit_breaker_record_total', {
      description:
        'Login IP circuit-breaker failure records, by outcome (incremented / unavailable).',
    });
    this.redisDurationHistogram = meter.createHistogram(
      'login_ip_circuit_breaker_redis_duration_seconds',
      {
        description:
          'Latency of the login IP circuit-breaker Redis round-trip, in seconds, by operation (check / record).',
        unit: 's',
      },
    );
  }

  /**
   * Return whether the breaker is currently tripped for `ip`.
   *
   * Called by `AuthService.login` BEFORE the user lookup so a tripped
   * breaker short-circuits the whole authentication path — the
   * attacker burns no bcrypt cycles, no DB read, no role lookup. The
   * cost of the breaker check is one Redis GET (sub-millisecond on a
   * warm connection).
   *
   * Returns `false` (not blocked) when Redis is unavailable — see the
   * fail-open posture documented in the class header. Returns `false`
   * when `ip` is empty / undefined; callers that don't have a usable
   * IP simply skip the breaker (the audit-log path tolerates a
   * missing IP and the per-user gate is still active).
   */
  async checkBlocked(ip: string | undefined): Promise<boolean> {
    // No usable IP → skip the breaker entirely (no Redis hop, no span,
    // no metric). The per-user LockoutService stays authoritative and
    // the audit-log path tolerates a missing IP.
    if (ip === undefined || ip.length === 0) return false;

    return withSpan('ip-circuit-breaker.check', async (span) => {
      const ipHash = hashIp(ip);
      span.setAttribute('breaker.ip_hash', ipHash);
      span.setAttribute('breaker.threshold', this.maxPerWindow);

      const nowSeconds = Math.floor(Date.now() / 1000);
      const key = this.bucketKey(ip, nowSeconds);
      const startNs = process.hrtime.bigint();

      let outcome: CheckOutcome = 'allowed';
      let blocked = false;
      try {
        const raw = await this.redis.get(key);
        if (raw !== null) {
          const count = Number(raw);
          if (Number.isNaN(count)) {
            // Malformed bucket value — fail open. Log for ops triage.
            this.logger.warn(
              { ipHash },
              'login-ip-circuit-breaker bucket returned non-numeric value; failing open',
            );
            outcome = 'unavailable';
          } else {
            blocked = count >= this.maxPerWindow;
            outcome = blocked ? 'blocked' : 'allowed';
          }
        }
      } catch (cause) {
        this.logger.warn(
          { ipHash, err: redisErrorMessage(cause) },
          'login-ip-circuit-breaker redis unavailable on check; failing open',
        );
        outcome = 'unavailable';
      } finally {
        this.recordRedisLatency('check', startNs);
      }

      span.setAttribute('breaker.outcome', outcome);
      this.checkCounter.add(1, { outcome });
      return blocked;
    });
  }

  /**
   * Record one failed login attempt against `ip`.
   *
   * INCR + EXPIRE the bucket atomically via a pipeline. The EXPIRE
   * sets the TTL to `windowSeconds` on every call — Redis treats the
   * second-and-onward EXPIRE as a no-op (the key already has a TTL),
   * which keeps the call shape uniform without an explicit
   * EXPIRE-if-not-exists primitive (older clusters don't carry
   * EXPIRE...NX).
   *
   * Silently swallows errors per the fail-open posture. The caller
   * doesn't await the result for control-flow purposes — the value
   * is informational only (e.g. for ops metrics or future log
   * enrichment). Returns the post-increment count or `null` if the
   * write failed.
   */
  async recordFailure(ip: string | undefined): Promise<number | null> {
    if (ip === undefined || ip.length === 0) return null;

    return withSpan('ip-circuit-breaker.record', async (span) => {
      const ipHash = hashIp(ip);
      span.setAttribute('breaker.ip_hash', ipHash);
      span.setAttribute('breaker.threshold', this.maxPerWindow);

      const nowSeconds = Math.floor(Date.now() / 1000);
      const key = this.bucketKey(ip, nowSeconds);
      const startNs = process.hrtime.bigint();

      let outcome: RecordOutcome = 'unavailable';
      let count: number | null = null;
      try {
        const pipeline = this.redis.multi();
        pipeline.incr(key);
        pipeline.expire(key, this.windowSeconds);
        const results = await pipeline.exec();

        if (results !== null && results.length > 0) {
          const incrEntry = results[0];
          if (Array.isArray(incrEntry) && incrEntry[0] === null) {
            const parsed = Number(incrEntry[1]);
            if (!Number.isNaN(parsed)) {
              count = parsed;
              outcome = 'incremented';
              // Log a warn at the trip boundary so ops can correlate
              // sustained probing without flooding the log with every
              // per-failure entry.
              if (count === this.maxPerWindow) {
                this.logger.warn(
                  { ipHash, count, threshold: this.maxPerWindow },
                  'login-ip-circuit-breaker tripped',
                );
              }
            }
          }
        }
      } catch (cause) {
        this.logger.warn(
          { ipHash, err: redisErrorMessage(cause) },
          'login-ip-circuit-breaker redis unavailable on record; failing open',
        );
        count = null;
        outcome = 'unavailable';
      } finally {
        this.recordRedisLatency('record', startNs);
      }

      span.setAttribute('breaker.outcome', outcome);
      if (count !== null) {
        span.setAttribute('breaker.count', count);
      }
      this.recordCounter.add(1, { outcome });
      return count;
    });
  }

  /**
   * Compose the bucket key. Extracted as a private method so the
   * env-prefix + hash + window logic has one definition and the unit
   * tests can verify cross-environment isolation by driving two
   * services with different `NODE_ENV` against the same FakeRedis.
   */
  private bucketKey(ip: string, nowSeconds: number): string {
    const window = Math.floor(nowSeconds / this.windowSeconds);
    return `${this.keyPrefix}:${hashIp(ip)}:${window}`;
  }

  /**
   * Record the wall-clock latency of one Redis round-trip on the
   * `login_ip_circuit_breaker_redis_duration_seconds` histogram. Called
   * from a `finally` block so the sample lands on every path — success,
   * fail-open error, and malformed-value — bucketed only by `operation`
   * (`check` / `record`) so the label cardinality stays bounded and no
   * IP leaks onto the metric.
   */
  private recordRedisLatency(operation: RedisOperation, startNs: bigint): void {
    const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    this.redisDurationHistogram.record(seconds, { operation });
  }
}

/**
 * Hash the raw IP into a short digest before it lands in a Redis key
 * or a log line. Avoids putting customer-identifying data in keys
 * that may be inspected by ops via `MONITOR` / `SLOWLOG`. Truncated
 * SHA-256 for storage compactness — collisions are tolerable at the
 * bucket cardinality and acceptable for the abuse-guard threat model.
 */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

function redisErrorMessage(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    const message = (cause as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unknown redis error';
}
