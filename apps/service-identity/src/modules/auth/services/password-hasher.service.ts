import { Injectable } from '@nestjs/common';
import { compare, hash } from 'bcrypt';

/**
 * Bcrypt cost factor (CLAUDE.md §3.1: cost ≥ 12).
 *
 * Bcrypt's cost is exponential: each increment doubles the work factor.
 * 12 yields ~250–400 ms per hash on modern x86_64 hardware (well above
 * the throughput an attacker can afford with stolen hashes, well below
 * what a signup/login flow notices). Bumping to 13/14 should be a
 * cluster-wide config change with a planned migration window — never
 * a quiet edit to this constant, because mixing cost factors over time
 * is fine but a sudden jump can spike CPU on a hot login path.
 */
export const BCRYPT_COST_FACTOR = 12;

/**
 * Wraps bcrypt with an injectable surface that the rest of the service
 * calls instead of touching `bcrypt` directly. The indirection lets
 * tests substitute a fake hasher (faster than real bcrypt for unit
 * tests) and keeps the cost factor in exactly one place.
 *
 * Bcrypt silently truncates inputs longer than 72 bytes — the
 * `SignupRequestSchema` already caps password length at 64 characters
 * (well under the 72-byte ceiling for any UTF-8 input), so this layer
 * does not need to defend against truncation again. A `length`
 * assertion here would be belt-and-braces but would also drift
 * silently from the contract policy.
 *
 * Raw passwords never leave this module's stack frame — they are not
 * logged, not propagated through events, and not re-exposed via any
 * accessor (CLAUDE.md §3.1: "Never log raw passwords or full tokens").
 */
@Injectable()
export class PasswordHasherService {
  /**
   * Hash a plaintext password and return the bcrypt digest.
   *
   * The digest format includes the algorithm, cost, and salt so
   * `verify()` can re-derive everything it needs without us storing
   * the cost separately. This makes future cost-factor migrations
   * (e.g. 12 → 13) a soft rollover rather than a forced re-hash.
   */
  async hash(plaintext: string): Promise<string> {
    return hash(plaintext, BCRYPT_COST_FACTOR);
  }

  /**
   * Verify a plaintext attempt against a stored bcrypt digest.
   *
   * `bcrypt.compare` is constant-time over the digest portion, which
   * mitigates timing oracles on the hash compare. Timing on
   * "user-not-found" (no digest at all) is the responsibility of the
   * caller — the standard mitigation is to run a dummy hash on the
   * miss path so the response time profile matches success/failure.
   * Login (TS-022) will own that pattern.
   */
  async verify(plaintext: string, digest: string): Promise<boolean> {
    return compare(plaintext, digest);
  }

  /**
   * Inspect the embedded cost factor of a stored digest so a
   * background worker (TS-022 era) can decide whether to opportunistically
   * re-hash on next successful login. The bcrypt format is
   * `$2[abxy]$<cost>$<22-char-salt><31-char-digest>`; we parse the
   * `<cost>` segment defensively.
   *
   * Returns `null` when the digest is malformed or unrecognised — the
   * caller treats null as "leave it alone" rather than "definitely
   * outdated."
   */
  inspectCost(digest: string): number | null {
    const match = /^\$2[abxy]\$(\d{2})\$/.exec(digest);
    if (match === null || match[1] === undefined) {
      return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
}
