import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Failed-login lockout policy (TS-025; CLAUDE.md §3.1).
 *
 * `LockoutService` owns one bit of state per user: how many consecutive
 * failed login attempts have accumulated since the most recent success,
 * and the current `lockedUntil` deadline derived from that count. The
 * surface is intentionally narrow — three methods that the `AuthService`
 * login flow calls in a fixed order — so the policy is easy to reason
 * about and easy to test.
 *
 * Two-tier defence. CLAUDE.md §3.1 names BOTH "exponential backoff at
 * the user level" AND an "IP-level circuit breaker". This service
 * implements the user-level tier only; the IP-level circuit breaker
 * is `IpCircuitBreakerService` (TS-025-followup-1, Redis-backed).
 * Redis is the right home for the IP layer because it is high-write
 * volume per IP, naturally TTL-bounded, and has no per-IP entity to
 * anchor a Postgres row to. The user-level tier persists durably in
 * Postgres so a lockout survives service restarts and replica failover.
 *
 * Schedule. The first two failures are tolerated without lock — most
 * "wrong password" attempts are typos by the legitimate user and we
 * do not want the very-first password mistake to put the account in
 * a one-minute time-out (that just trains users to be afraid of the
 * login form). From the third failure onward we lock for
 * `min(60s * 2^(count - 3), 24h)`. The doubling sequence: count 3 →
 * 1m, 4 → 2m, 5 → 4m, 6 → 8m, 7 → 16m, 8 → 32m, 9 → 64m, 10 → 128m,
 * 11 → 256m, 12 → 512m, 13 → 1024m (~17h). Count 14 would raw-produce
 * ~34h but the 24h cap clamps it; every higher count stays at the
 * 24h ceiling. The cap exists so a single account cannot be DOS'd by
 * a sustained attacker — after enough failures the account is
 * effectively locked for a fixed-but-bounded window while the human
 * owner has the morning to email support.
 *
 * Anti-shrinkage. Concurrent failed-login attempts could each compute
 * a `lockedUntil` based on a stale count read. Without precautions
 * the slower-to-commit update could overwrite a later, more
 * aggressive lock with an earlier, looser one. `recordFailure` runs
 * the increment + the lock update inside a `$transaction` and chooses
 * `max(existingLock, newLock)` so the lock can only ever extend,
 * never retract — the worst case under contention is a redundant
 * write, not a weakened lock.
 *
 * Lock expiry. We deliberately do NOT auto-clear an expired
 * `lockedUntil` on read. Two reasons: (1) The lock-expiry path is a
 * pure read against `locked_until > now`, so there is nothing to
 * clear at read time. (2) The first successful login after an
 * expired lock is exactly when we want to reset the counter — so
 * `recordSuccess` does the cleanup atomically once the user has
 * actually authenticated. No background sweeper is required.
 *
 * What this service does NOT do. It does not directly compose with
 * `AuthService.login` — the wiring (who calls which method when) is
 * orchestrated by the login flow. Its three methods are atomic
 * single-row operations that the orchestrator stitches into the
 * larger sequence (look up user → verify password → check lockout →
 * either issue session or record failure).
 */
@Injectable()
export class LockoutService {
  private readonly logger = new Logger(LockoutService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return whether the user's lockout window has not yet elapsed.
   *
   * The caller passes the user's current `lockedUntil` (already
   * loaded by the login flow's user lookup) so we do not re-fetch
   * the row — the existing user query already projects every column
   * we need. `now` defaults to wall-clock time; tests supply a fixed
   * instant to make schedule expectations deterministic.
   *
   * Note that this is a pure helper — no DB read, no DB write. The
   * read-side state lives on the `users` row that the orchestrator
   * has already loaded.
   */
  isLocked(lockedUntil: Date | null, now: Date = new Date()): boolean {
    if (lockedUntil === null) return false;
    return lockedUntil.getTime() > now.getTime();
  }

  /**
   * Record one failed authentication attempt against `userId` and
   * apply the lockout schedule.
   *
   * Behaviour:
   *  1. Atomically increment `failed_login_count` and stamp
   *     `last_failed_login_at`.
   *  2. Read back the resulting count and the row's current
   *     `lockedUntil`.
   *  3. Compute the new lock deadline from the schedule (or null,
   *     for counts ≤ 2).
   *  4. If the new deadline is non-null AND strictly later than the
   *     existing one, write it. Otherwise leave the existing lock
   *     in place. This is the anti-shrinkage rule documented in the
   *     class header.
   *
   * The increment + read + conditional update run inside a single
   * `$transaction` so concurrent failures cannot interleave their
   * lock writes against a stale count read.
   *
   * Idempotency. If the user row is missing (race with deletion),
   * Prisma raises `P2025`. We swallow it and return a `null`-shaped
   * result rather than propagating — losing one failure count on a
   * just-deleted account is the right trade-off (the alternative
   * would surface a 500 to the caller).
   */
  async recordFailure(
    userId: string,
    now: Date = new Date(),
  ): Promise<{ readonly failedLoginCount: number; readonly lockedUntil: Date | null }> {
    type TxClient = {
      user: PrismaService['user'];
    };
    try {
      return await this.prisma.$transaction(async (tx: TxClient) => {
        const updated = await tx.user.update({
          where: { id: userId },
          data: {
            failedLoginCount: { increment: 1 },
            lastFailedLoginAt: now,
          },
          select: { failedLoginCount: true, lockedUntil: true },
        });

        const candidate = computeLockedUntil(updated.failedLoginCount, now);
        const effectiveLock = chooseLaterLock(updated.lockedUntil, candidate);

        // Only write when the chosen lock differs from the
        // currently-persisted value — avoids a no-op UPDATE that
        // would still bump `updated_at` and produce an audit-log
        // row for no behavioural change.
        if (sameInstant(effectiveLock, updated.lockedUntil)) {
          return {
            failedLoginCount: updated.failedLoginCount,
            lockedUntil: updated.lockedUntil,
          };
        }

        const persisted = await tx.user.update({
          where: { id: userId },
          data: { lockedUntil: effectiveLock },
          select: { lockedUntil: true },
        });

        if (effectiveLock !== null) {
          // Warn-level so ops can correlate sustained-failure
          // patterns; userId only, never the email or the failed
          // password (PII / secret hygiene per CLAUDE.md §10).
          this.logger.warn(
            {
              userId,
              failedLoginCount: updated.failedLoginCount,
              lockedUntil: effectiveLock.toISOString(),
            },
            'login lockout extended',
          );
        }

        return {
          failedLoginCount: updated.failedLoginCount,
          lockedUntil: persisted.lockedUntil,
        };
      });
    } catch (err) {
      if (isPrismaRecordNotFoundError(err)) {
        // Row vanished between the orchestrator's lookup and the
        // increment — likely a soft-delete or hard-delete race.
        // Return a benign result so the login orchestrator's
        // generic-401 path still fires.
        this.logger.debug(
          { userId },
          'recordFailure skipped — user row missing (likely deletion race)',
        );
        return { failedLoginCount: 0, lockedUntil: null };
      }
      throw err;
    }
  }

  /**
   * Clear the counter on a successful authentication.
   *
   * Resets `failed_login_count` to 0, `lastFailedLoginAt` to null,
   * and `lockedUntil` to null. The combined reset is one UPDATE
   * statement — Postgres makes that atomic without an explicit
   * transaction.
   *
   * If the row is missing (deletion race) we swallow `P2025` for
   * the same reason as `recordFailure`: the orchestrator has
   * already mapped the user-not-found state and we should not
   * convert a benign race into a 500.
   */
  async recordSuccess(userId: string): Promise<void> {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedLoginCount: 0,
          lastFailedLoginAt: null,
          lockedUntil: null,
        },
        select: { id: true },
      });
    } catch (err) {
      if (isPrismaRecordNotFoundError(err)) {
        this.logger.debug(
          { userId },
          'recordSuccess skipped — user row missing (likely deletion race)',
        );
        return;
      }
      throw err;
    }
  }
}

/**
 * Pure function — derived solely from `count` and `now`. Exported for
 * unit testing the schedule directly without spinning up the service.
 *
 *   count ≤ 2 → no lock (return null)
 *   count ≥ 3 → lock for min(60s * 2^(count - 3), 24h) from `now`
 *
 * 24h cap chosen so a sustained attacker cannot extend the lock
 * indefinitely (`2^(count - 3)` grows without bound otherwise). The
 * 24h ceiling is also a natural "call support tomorrow morning"
 * window for the legitimate user.
 */
export function computeLockedUntil(count: number, now: Date): Date | null {
  if (count <= LOCKOUT_GRACE_THRESHOLD) return null;
  const exponent = count - LOCKOUT_GRACE_THRESHOLD - 1;
  // Math.pow can overflow Number for absurdly large `count`; clamp
  // the exponent so we never produce Infinity in the multiplication.
  const safeExponent = Math.min(exponent, LOCKOUT_MAX_EXPONENT);
  const seconds = LOCKOUT_BASE_SECONDS * 2 ** safeExponent;
  const cappedSeconds = Math.min(seconds, LOCKOUT_CAP_SECONDS);
  return new Date(now.getTime() + cappedSeconds * 1000);
}

/**
 * Returns whichever lock instant is strictly later, treating `null`
 * as "no lock" (earlier than any concrete instant). Used by
 * `recordFailure` to enforce the anti-shrinkage rule.
 */
function chooseLaterLock(existing: Date | null, candidate: Date | null): Date | null {
  if (candidate === null) return existing;
  if (existing === null) return candidate;
  return candidate.getTime() > existing.getTime() ? candidate : existing;
}

/**
 * True when both pointers represent the same instant — including
 * "both null". Used to short-circuit no-op writes.
 */
function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

/**
 * Narrow `unknown` to a Prisma `RecordNotFound` (P2025) error
 * shape via duck typing. Same rationale as the duck typing in
 * `AuthService` (see TS-021-followup-2): the `Prisma`
 * namespace's value side resolves inconsistently under our
 * strict tsconfig, and we only need a `.code` check anyway.
 */
function isPrismaRecordNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'P2025';
}

/** Failures before the schedule starts charging a lock (inclusive). */
const LOCKOUT_GRACE_THRESHOLD = 2;
/** Base lock window for the first locked failure: 60 seconds. */
const LOCKOUT_BASE_SECONDS = 60;
/** Max lock window: 24h. */
const LOCKOUT_CAP_SECONDS = 24 * 60 * 60;
/**
 * Safety bound on the exponent so absurdly large counts cannot
 * produce a non-finite multiplication before the cap clamps the
 * result. 2^32 seconds is already ~136 years — well past the cap.
 */
const LOCKOUT_MAX_EXPONENT = 32;
