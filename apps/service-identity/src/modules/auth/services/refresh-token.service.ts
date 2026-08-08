import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { TokenService } from './token.service';

/**
 * Discriminated result of a `rotate()` call.
 *
 * The caller must handle every variant — `ok: false` is not an exception
 * because all four failure modes are normal-flow outcomes (user logged
 * out long ago, session expired, attacker presented a stolen token).
 * Encoding them as branches forces explicit handling at the controller
 * (CLAUDE.md §2.1: `Result<T, E>` over silent throws across boundaries).
 */
export type RotateResult =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly familyId: string;
      readonly newRawRefreshToken: string;
      readonly newRefreshExpiresAt: Date;
    }
  | { readonly ok: false; readonly reason: 'unknown' | 'reused' | 'expired' | 'revoked' };

/**
 * Refresh-token rotation engine — the heart of CLAUDE.md §3.1's
 * "rotating with reuse detection" rule.
 *
 * State machine of a single token row:
 *
 *   issued → rotated   (normal exchange path; `rotatedAt` set)
 *   issued → revoked   (logout / admin / reuse detection on a sibling)
 *   rotated → revoked  (reuse detection: someone presented this *after*
 *                       it was already exchanged → revoke whole family)
 *
 * Three policies enforced here:
 *
 *   1. **Reuse detection** — presenting a token whose row has
 *      `rotatedAt != null` means either the legitimate client retried
 *      (rare, but plausible network-loss scenario) OR an attacker is
 *      replaying. Either way the safe response is to revoke the whole
 *      family and emit a warn log carrying the family id (no PII) so
 *      ops can correlate with trust-and-safety signals.
 *
 *   2. **Expiry** — `expiresAt < now` returns `expired` without touching
 *      the family. (Expired tokens have nothing left to "rotate from"
 *      and there is no reuse claim to make against an expired row.)
 *
 *   3. **Revocation** — already-revoked rows return `revoked`. Includes
 *      both family-revoked rows and individually-revoked rows (today
 *      we only ever revoke at the family level, but keeping the gate
 *      future-proofs admin "kill this specific session" workflows).
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  /**
   * Issue a brand-new refresh token in its own family. Returns the raw
   * token to give the client and the family id (used as the access
   * token's `sid` claim).
   *
   * The three optional TS-297 knobs serve impersonation sessions:
   * `expiresAt` caps the family below the ordinary 30-day TTL,
   * `impersonatorUserId` marks every row in the family with the true
   * operator, and `tx` lets the mint run inside the caller's
   * transaction so the session row commits atomically with its
   * `user_impersonation:start` audit event.
   */
  async issueNewSession(args: {
    readonly userId: string;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
    readonly expiresAt?: Date | undefined;
    readonly impersonatorUserId?: string | undefined;
    readonly tx?: { readonly refreshToken: PrismaService['refreshToken'] } | undefined;
  }): Promise<{
    readonly familyId: string;
    readonly rawRefreshToken: string;
    readonly expiresAt: Date;
  }> {
    const familyId = generateFamilyId();
    const { raw, hash } = this.tokenService.generateRefreshToken();
    const expiresAt = args.expiresAt ?? this.tokenService.refreshTokenExpiresAt();
    const client = args.tx ?? this.prisma;

    await client.refreshToken.create({
      data: {
        familyId,
        userId: args.userId,
        tokenHash: hash,
        expiresAt,
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
        impersonatorUserId: args.impersonatorUserId ?? null,
      },
      select: { id: true },
    });

    return { familyId, rawRefreshToken: raw, expiresAt };
  }

  /**
   * Exchange a presented refresh token for a new one. Implements the
   * rotation + reuse-detection policy described in the class comment.
   *
   * The whole flow runs in a single transaction so reuse detection is
   * atomic with the family-revocation update (no race where two
   * concurrent reuses each "win" and only revoke once).
   */
  async rotate(args: {
    readonly presentedRawToken: string;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
  }): Promise<RotateResult> {
    const presentedHash = this.tokenService.hashRefreshToken(args.presentedRawToken);
    const now = new Date();

    // `tx` is the generated `Prisma.TransactionClient`, and the callback
    // declares its return type explicitly. Both matter: the previous
    // hand-rolled `{ refreshToken: ... }` shape did not satisfy the
    // interactive-transaction overload, so TypeScript fell through to the
    // array form of `$transaction` and widened this method's result from
    // the `RotateResult` union to `{ ok: boolean }` — which silently
    // defeated the exhaustiveness checking the reuse-detection callers
    // depend on (CLAUDE.md §2.1, §3.1).
    return this.prisma.$transaction(async (tx: PrismaTransactionClient): Promise<RotateResult> => {
      const row = await tx.refreshToken.findUnique({
        where: { tokenHash: presentedHash },
        select: {
          id: true,
          familyId: true,
          userId: true,
          expiresAt: true,
          rotatedAt: true,
          revokedAt: true,
        },
      });

      if (row === null) {
        return { ok: false, reason: 'unknown' as const };
      }

      if (row.revokedAt !== null) {
        return { ok: false, reason: 'revoked' as const };
      }

      // Reuse detection: this token was already exchanged. Revoke the
      // entire family and refuse the request. Run inside the same tx so
      // the family-wide updateMany sees a consistent set of rows.
      if (row.rotatedAt !== null) {
        await tx.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        this.logger.warn(
          { familyId: row.familyId, userId: row.userId },
          'refresh-token reuse detected — family revoked',
        );
        return { ok: false, reason: 'reused' as const };
      }

      if (row.expiresAt.getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired' as const };
      }

      // Rotate: mark the presented token rotated, insert a fresh row in
      // the same family with a fresh hash and expiry.
      const { raw, hash } = this.tokenService.generateRefreshToken();
      const newExpiresAt = this.tokenService.refreshTokenExpiresAt(now);

      await tx.refreshToken.update({
        where: { id: row.id },
        data: { rotatedAt: now },
        select: { id: true },
      });

      await tx.refreshToken.create({
        data: {
          familyId: row.familyId,
          userId: row.userId,
          tokenHash: hash,
          expiresAt: newExpiresAt,
          ip: args.ip ?? null,
          userAgent: args.userAgent ?? null,
        },
        select: { id: true },
      });

      return {
        ok: true as const,
        userId: row.userId,
        familyId: row.familyId,
        newRawRefreshToken: raw,
        newRefreshExpiresAt: newExpiresAt,
      };
    });
  }

  /**
   * Revoke every active token in a family — used by `/logout` and as the
   * admin "log this session out" action. Idempotent: re-revoking is a
   * no-op (the WHERE clause filters out already-revoked rows).
   */
  async revokeFamily(
    familyId: string,
    now: Date = new Date(),
  ): Promise<{ readonly revokedCount: number }> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { revokedCount: result.count };
  }

  /**
   * Revoke every active token across every family for a single user —
   * the "log out everywhere" hammer. Used by surfaces that change a
   * user's authentication posture and want to force re-login on every
   * outstanding session: MFA enrollment confirmed (TS-023-followup-5),
   * MFA method removed, recovery-code consumed (TS-023-followup-2),
   * password reset (future), and admin "kill every session for user X"
   * (TS-126).
   *
   * Idempotent — already-revoked rows are filtered out by the WHERE
   * clause so a repeat call is a no-op.
   *
   * Accepts an optional `tx` parameter so callers can run the
   * revocation inside an existing transaction (e.g. MfaService's
   * `confirmEnrollment` runs the method update, the user flag flip,
   * and this revocation in one transaction so a rollback on any leg
   * unwinds them all together — keeping the "if MFA changed, sessions
   * are gone" invariant atomic). Falls back to the service's own
   * Prisma client when no transaction context is provided.
   */
  async revokeAllFamiliesForUser(
    userId: string,
    options: {
      readonly now?: Date;
      readonly tx?: { readonly refreshToken: PrismaService['refreshToken'] };
    } = {},
  ): Promise<{ readonly revokedCount: number }> {
    const now = options.now ?? new Date();
    const client = options.tx ?? this.prisma;
    const result = await client.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    return { revokedCount: result.count };
  }

  /**
   * Look up the family id for a presented raw refresh token. Used by
   * `/logout` so we can revoke the family without going through the
   * full rotate() machinery (which would trigger reuse-detection logic
   * we explicitly don't want on a logout — the user's intent is "end
   * this session", not "report suspected theft").
   *
   * Returns null when the token is unknown. Does NOT distinguish
   * already-rotated / revoked / expired rows — the caller is logging
   * out anyway, so any of those are equivalent to "nothing to do".
   */
  async findFamilyForRawToken(rawToken: string): Promise<{ readonly familyId: string } | null> {
    const hash = this.tokenService.hashRefreshToken(rawToken);
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      select: { familyId: true },
    });
    return row;
  }
}

/**
 * 16-byte CSPRNG family id, hex-encoded. Independent of the token's
 * randomness so a token leak doesn't leak the family id (and vice versa).
 */
function generateFamilyId(): string {
  return randomBytes(16).toString('hex');
}
