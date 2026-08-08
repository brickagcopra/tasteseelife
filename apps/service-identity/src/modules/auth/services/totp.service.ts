import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * RFC 6238 TOTP — implemented from scratch using Node `crypto` only.
 *
 * Why no library. The mainline Node TOTP libs (`speakeasy`, `otplib`)
 * are not on the CLAUDE.md §13 approved list. RFC 6238 is short,
 * unambiguous, and built entirely on HMAC-SHA-1 over an 8-byte
 * counter — a well-tested standard since 2011 — so the from-scratch
 * implementation is ~50 lines of straightforward code with the RFC
 * 6238 / RFC 4226 test vectors as the verification harness.
 *
 * Standards.
 *   - RFC 4226 (HOTP) — the dynamic-truncation construction.
 *   - RFC 6238 (TOTP) — the step-counter HOTP variant.
 *   - RFC 4648 §6   — base32 encoding for the shared secret in
 *                     otpauth:// URLs (the format every authenticator
 *                     app understands).
 *
 * Hash algorithm. RFC 6238 §1.2 mandates HMAC-SHA-1 as the default;
 * §1.2 also explicitly allows SHA-256 / SHA-512 with the optional
 * `algorithm=` parameter on the otpauth URL. We pin SHA-1 because
 * (a) every authenticator app supports it without a fuss and (b) the
 * 80-bit security floor of HMAC-SHA-1 (the truncation collapses to
 * 31 bits anyway under dynamic truncation) is more than sufficient
 * for a 30-second-window 6-digit code that has at most ~1M brute-
 * force attempts even ignoring rate limits.
 *
 * Constant-time comparison. Code matching uses
 * `crypto.timingSafeEqual` so a wrong code's failure cannot be
 * distinguished from a right one's success by response timing.
 *
 * Replay protection lives one layer up. This service generates and
 * verifies codes against a bare secret + step number; it does not
 * remember which step was last accepted. `MfaService` carries the
 * `lastUsedStep` state per method (`mfa_methods.last_used_step`) and
 * uses `verifyCode`'s returned `step` to advance the watermark and
 * reject earlier-or-equal steps on subsequent calls.
 */
@Injectable()
export class TotpService {
  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  /**
   * Generate a fresh TOTP shared secret as a base32 string.
   *
   * RFC 4226 §4 R6 recommends a shared-secret length of at least
   * 128 bits (16 bytes); 160 bits (20 bytes) is the standard for
   * SHA-1 because it matches the HMAC-SHA-1 block size. We default
   * to 20 bytes — the same length every authenticator app produces
   * when generating a key on its own, and the RFC 4226 test-vector
   * length.
   */
  generateSecret(): string {
    return base32Encode(randomBytes(20));
  }

  /**
   * Build the `otpauth://totp/...` URL that an authenticator app
   * scans (typically rendered as a QR by the client). Format:
   *
   *   otpauth://totp/{Issuer}:{label}?secret={base32}&issuer={Issuer}
   *           &algorithm=SHA1&digits={digits}&period={periodSeconds}
   *
   * `label` is conventionally the user's email/username — both the
   * issuer prefix on the path AND the `issuer=` query string are
   * present per the de-facto Google Authenticator spec (some apps
   * read one, some the other; including both maximises compatibility).
   *
   * `algorithm` / `digits` / `period` are explicitly emitted even
   * though SHA-1 / 6 / 30 are the defaults — pinning them in the URL
   * means a future server-side default change cannot silently
   * desynchronise an already-paired authenticator.
   *
   * The label and issuer are URL-component-encoded per the otpauth
   * spec; colons in the label segment are reserved.
   */
  buildOtpauthUrl(args: { readonly accountLabel: string; readonly secretBase32: string }): string {
    const issuer = this.env.MFA_TOTP_ISSUER;
    const issuerEncoded = encodeURIComponent(issuer);
    const labelEncoded = encodeURIComponent(args.accountLabel);
    const params = new URLSearchParams({
      secret: args.secretBase32,
      issuer,
      algorithm: 'SHA1',
      digits: String(this.env.MFA_TOTP_DIGITS),
      period: String(this.env.MFA_TOTP_PERIOD_SECONDS),
    });
    return `otpauth://totp/${issuerEncoded}:${labelEncoded}?${params.toString()}`;
  }

  /**
   * Generate a TOTP code for a given step (or now).
   *
   * Public on the service so unit tests can pin a step; production
   * call sites typically use `verifyCode` which derives the step
   * internally.
   */
  generateCode(secretBase32: string, step?: number): string {
    const stepValue = step ?? this.currentStep();
    return totpCode({
      secret: base32Decode(secretBase32),
      step: stepValue,
      digits: this.env.MFA_TOTP_DIGITS,
    });
  }

  /**
   * Verify a candidate code against a shared secret, with ±window
   * step-skew tolerance for client clock drift. Returns the matched
   * step on success, `null` on failure.
   *
   * The matched step is what `MfaService` uses to advance its
   * `last_used_step` replay-defence watermark — the caller MUST
   * persist this so the same code cannot be replayed in the next
   * verify within the 90s acceptance window.
   *
   * Constant-cost comparison. We always evaluate every candidate
   * step in the window — even if the first one matches — so the
   * timing profile of "matched on the first try" cannot be
   * distinguished from "matched on the last." This is paranoid
   * (HMAC-SHA-1 + truncation is hardly a timing oracle) but the
   * cost is microseconds.
   *
   * `lastUsedStep`. When supplied, any candidate step ≤ the
   * watermark is rejected up front — this is the in-process replay
   * guard. The MfaService passes the column value here.
   */
  verifyCode(args: {
    readonly secretBase32: string;
    readonly candidate: string;
    readonly window?: number;
    readonly now?: Date;
    readonly lastUsedStep?: number | null;
  }): number | null {
    const window = args.window ?? this.env.MFA_TOTP_WINDOW;
    const digits = this.env.MFA_TOTP_DIGITS;

    // Length check is cheap; reject obviously-malformed inputs before
    // we even decode the secret. Also keeps `timingSafeEqual` from
    // throwing on length mismatch.
    if (args.candidate.length !== digits || !/^\d+$/.test(args.candidate)) {
      return null;
    }

    const center = this.currentStep(args.now);
    const secret = base32Decode(args.secretBase32);
    const candidateBuf = Buffer.from(args.candidate, 'utf8');

    let matchedStep: number | null = null;
    for (let offset = -window; offset <= window; offset++) {
      const step = center + offset;
      if (
        args.lastUsedStep !== undefined &&
        args.lastUsedStep !== null &&
        step <= args.lastUsedStep
      ) {
        // Replay guard: any earlier-or-equal step than the last
        // accepted one is invalid. Skip without timing leakage —
        // the inner branch is a no-op even when a match would have
        // happened.
        continue;
      }
      const expected = totpCode({ secret, step, digits });
      const expectedBuf = Buffer.from(expected, 'utf8');
      // Constant-time compare. Both buffers are guaranteed `digits`-
      // long here.
      if (timingSafeEqual(candidateBuf, expectedBuf) && matchedStep === null) {
        matchedStep = step;
      }
    }
    return matchedStep;
  }

  /**
   * Current TOTP step (Unix seconds / period). Centralised so tests
   * can stub `now`.
   */
  currentStep(now: Date = new Date()): number {
    return Math.floor(now.getTime() / 1000 / this.env.MFA_TOTP_PERIOD_SECONDS);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Module-private primitives — kept out of the @Injectable surface so
// unit tests can exercise the standards-compliance edge cases without
// a DI container, and so the algorithm is mechanically obvious from
// reading top-to-bottom.
// ─────────────────────────────────────────────────────────────────────

/**
 * Compute one TOTP code per RFC 6238 / RFC 4226 — HMAC-SHA-1 over
 * the 8-byte big-endian step counter, dynamically-truncated, modulo
 * 10^digits, zero-padded to `digits` chars.
 */
function totpCode(args: {
  readonly secret: Buffer;
  readonly step: number;
  readonly digits: number;
}): string {
  // 8-byte big-endian step counter. RFC 4226 §5.1: "the counter must
  // be ... an 8-byte counter value." We use BigInt for the high half
  // to stay safe past 2038 (TOTP step counters grow forever).
  const counter = Buffer.alloc(8);
  counter.writeBigInt64BE(BigInt(args.step), 0);

  const hmac = createHmac('sha1', args.secret).update(counter).digest();

  // Dynamic truncation per RFC 4226 §5.3.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  // The four bytes at `offset` form a 31-bit unsigned int (top bit
  // masked to dodge sign-extension surprises in language runtimes
  // that lack unsigned ints).
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 10 ** args.digits;
  return otp.toString().padStart(args.digits, '0');
}

/**
 * RFC 4648 §6 base32 encoding. Lower-case is permitted by the spec
 * but most authenticator app QR scanners are case-sensitive about
 * the upper-case variant — keep upper-case as the canonical output.
 *
 * Padding (`=`) is omitted from the otpauth secret per the de-facto
 * Google Authenticator spec — most authenticator apps strip the
 * padding anyway, but explicit removal avoids the URL needing
 * percent-encoding.
 */
function base32Encode(input: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < input.length; i++) {
    value = (value << 8) | input[i]!;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * RFC 4648 §6 base32 decoding. Tolerates lower-case input (some
 * authenticator apps emit it) and strips spaces / padding before
 * decoding (some users paste with spacing). Throws on any character
 * outside the alphabet — better to surface a corrupted secret as a
 * loud failure than to silently produce a different secret.
 */
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    const idx = alphabet.indexOf(ch);
    if (idx < 0) {
      throw new Error(`base32 decode: invalid character '${ch}' at offset ${i}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Test-only re-exports. Not part of the public service surface; the
// unit tests reach into these to verify the standards-compliance
// edge cases (RFC 4226 / 6238 vectors, base32 round-trip).
export const _internals = { totpCode, base32Encode, base32Decode };
