import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * One-time MFA recovery (backup) codes (TS-023-followup-2; PDD §10.1,
 * CLAUDE.md §3.1).
 *
 * Recovery codes are the standard ergonomic pairing for any TOTP
 * rollout: a lost authenticator is otherwise a support ticket (and a
 * hard lockout for admin staff gated by the admin-MFA gate in
 * `AuthService.login`). `MfaService.confirmEnrollment` mints a batch at
 * enrollment-confirm time, returns the plaintext to the client EXACTLY
 * once, and persists only hashes. During the second login step the user
 * may present one code in lieu of a TOTP code; `verifyAndConsume` marks
 * the matched row spent and never accepts it again.
 *
 * Why hash, not encrypt (mirrors `RefreshToken.tokenHash`): the raw
 * value is a high-entropy opaque token the server never needs to
 * recover — it only compares a presented code's hash against the stored
 * hash. SHA-256 is the right primitive (fast, single-row lookup); bcrypt
 * would slow down a value that has nothing low-entropy to protect.
 */
@Injectable()
export class MfaRecoveryCodeService {
  private readonly logger = new Logger(MfaRecoveryCodeService.name);

  /**
   * How many codes a batch contains. 10 sits at the top of the
   * industry-standard 8–10 range (GitHub / Google issue ~10) — enough
   * that a user burning one per lost-device incident has ample runway
   * before they must regenerate.
   */
  static readonly CODE_COUNT = 10;

  /**
   * Characters per code (before grouping separators). 10 chars over the
   * 32-symbol alphabet below = 50 bits of entropy per code — far beyond
   * any online-guessing threat given the single-use consumption + the
   * MFA challenge gate that already bounds attempts. Crockford base32
   * (no I/L/O/U) keeps hand-typed codes unambiguous.
   */
  private static readonly CODE_LENGTH = 10;

  /**
   * Crockford base32 alphabet — digits plus A–Z minus the visually
   * ambiguous I, L, O, U. Exactly 32 symbols, so a 5-bit slice of a
   * random byte maps to one symbol with ZERO modulo bias (32 = 2^5).
   */
  private static readonly ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  /** Group size for the display form (`XXXXX-XXXXX`). */
  private static readonly GROUP_SIZE = 5;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Generate a fresh batch for the user. Deletes any existing batch
   * first (idempotent re-enrol — a user who re-enrols MFA gets a clean
   * set; stale codes from a prior enrollment never linger). Returns the
   * plaintext display-form codes — the ONLY moment they exist in clear;
   * the caller surfaces them to the user once and the server keeps only
   * hashes.
   *
   * Runs inside the caller's transaction when `tx` is supplied so the
   * batch insert commits atomically with the enrollment-confirm writes
   * (CLAUDE.md §6 spirit: related state changes succeed or fail
   * together).
   */
  async generate(args: {
    readonly userId: string;
    readonly tx?: RecoveryCodeTxClient | undefined;
  }): Promise<readonly string[]> {
    const client = args.tx ?? this.prisma;

    const displayCodes: string[] = [];
    const rows: Array<{ userId: string; codeHash: string }> = [];
    const seen = new Set<string>();
    while (displayCodes.length < MfaRecoveryCodeService.CODE_COUNT) {
      const normalized = this.randomCode();
      // Defence-in-depth against the astronomically-unlikely duplicate
      // inside one batch (50-bit codes make a collision a non-event,
      // but a duplicate would violate the unique index and abort the
      // whole transaction — cheaper to skip-and-retry here).
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      displayCodes.push(this.toDisplay(normalized));
      rows.push({ userId: args.userId, codeHash: this.hash(normalized) });
    }

    await client.mfaRecoveryCode.deleteMany({ where: { userId: args.userId } });
    await client.mfaRecoveryCode.createMany({ data: rows });

    this.logger.log({ userId: args.userId, count: rows.length }, 'mfa recovery codes generated');
    return displayCodes;
  }

  /**
   * Verify a presented recovery code against the user's unused codes
   * and consume it on success. Returns true if a fresh code matched
   * (now spent), false otherwise.
   *
   * Race-safety: the consume is a conditional `updateMany ... WHERE
   * code_hash = ? AND user_id = ? AND consumed_at IS NULL`. Two
   * concurrent presentations of the same code resolve to exactly one
   * winner — the loser's update affects 0 rows and is treated as a
   * miss. The `userId` predicate means a code only works for the user
   * it was minted for even though `code_hash` is globally unique.
   *
   * A malformed code (wrong length / out-of-alphabet character) is a
   * fast `false` — never a database round trip and never an
   * enumeration signal (the recovery-verify endpoint renders every
   * failure as the same generic 401).
   */
  async verifyAndConsume(args: {
    readonly userId: string;
    readonly code: string;
  }): Promise<boolean> {
    const normalized = this.normalize(args.code);
    if (normalized === null) {
      this.logger.warn({ userId: args.userId }, 'mfa recovery verify rejected — malformed code');
      return false;
    }
    const codeHash = this.hash(normalized);
    const result = await this.prisma.mfaRecoveryCode.updateMany({
      where: { codeHash, userId: args.userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    const ok = result.count > 0;
    if (ok) {
      this.logger.log({ userId: args.userId }, 'mfa recovery code consumed');
    } else {
      this.logger.warn({ userId: args.userId }, 'mfa recovery verify failed');
    }
    return ok;
  }

  /**
   * Count the user's remaining (unused) recovery codes. Surfaced to the
   * account screen so a user can see when they should regenerate; also
   * used by `verifyAndConsume` callers that want to warn "this was your
   * last code". Cheap indexed count.
   */
  async countRemaining(userId: string): Promise<number> {
    return this.prisma.mfaRecoveryCode.count({
      where: { userId, consumedAt: null },
    });
  }

  /**
   * Hard-delete every recovery code for the user. Called when MFA is
   * fully disabled (`MfaService.removeMethod` retiring the last
   * confirmed method) — recovery codes are meaningless without an MFA
   * factor to recover. Runs inside the caller's transaction when `tx`
   * is supplied.
   */
  async invalidateAll(args: {
    readonly userId: string;
    readonly tx?: RecoveryCodeTxClient | undefined;
  }): Promise<number> {
    const client = args.tx ?? this.prisma;
    const result = await client.mfaRecoveryCode.deleteMany({
      where: { userId: args.userId },
    });
    if (result.count > 0) {
      this.logger.log(
        { userId: args.userId, count: result.count },
        'mfa recovery codes invalidated',
      );
    }
    return result.count;
  }

  /**
   * Draw one normalised code: CODE_LENGTH symbols from the 32-symbol
   * alphabet via unbiased 5-bit slices of cryptographically-random
   * bytes.
   */
  private randomCode(): string {
    const bytes = randomBytes(MfaRecoveryCodeService.CODE_LENGTH);
    let out = '';
    for (let i = 0; i < MfaRecoveryCodeService.CODE_LENGTH; i += 1) {
      // `bytes[i]` is defined for i < length; the `?? 0` satisfies
      // noUncheckedIndexedAccess without changing behaviour.
      const index = (bytes[i] ?? 0) & 0x1f; // low 5 bits → 0..31
      out += MfaRecoveryCodeService.ALPHABET[index];
    }
    return out;
  }

  /** Group a normalised code into the human display form `XXXXX-XXXXX`. */
  private toDisplay(normalized: string): string {
    const groups: string[] = [];
    for (let i = 0; i < normalized.length; i += MfaRecoveryCodeService.GROUP_SIZE) {
      groups.push(normalized.slice(i, i + MfaRecoveryCodeService.GROUP_SIZE));
    }
    return groups.join('-');
  }

  /**
   * Normalise a user-presented code to its canonical hashable form:
   * uppercase, strip every non-alphabet character (separators, spaces),
   * then validate length + alphabet membership. Returns null on any
   * malformed input so callers fail fast without a DB round trip.
   *
   * Crockford-style leniency is deliberate: many users will transcribe
   * a printed code and may mistype the ambiguous glyphs the alphabet
   * already excludes — but we do NOT silently fold O→0 / I→1 here
   * because the alphabet never emits those source glyphs, so a typed
   * `O` is genuinely wrong rather than an ambiguity to resolve.
   */
  private normalize(raw: string): string | null {
    const stripped = raw
      .toUpperCase()
      .split('')
      .filter((ch) => MfaRecoveryCodeService.ALPHABET.includes(ch))
      .join('');
    if (stripped.length !== MfaRecoveryCodeService.CODE_LENGTH) return null;
    return stripped;
  }

  /** SHA-256(normalisedCode) base64url. See class header for rationale. */
  private hash(normalized: string): string {
    return createHash('sha256').update(normalized, 'utf8').digest('base64url');
  }
}

/**
 * Structural type for the Prisma delegate surface this service touches
 * inside a transaction. Mirrors the `TxClient` shapes elsewhere in the
 * auth module — kept narrow so a caller passing its `$transaction`
 * client only needs to satisfy the `mfaRecoveryCode` delegate, not the
 * whole client.
 */
export interface RecoveryCodeTxClient {
  readonly mfaRecoveryCode: PrismaService['mfaRecoveryCode'];
}
