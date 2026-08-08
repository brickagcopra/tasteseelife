import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import { MfaRecoveryCodeService } from './mfa-recovery-code.service';
import { MfaSecretCipherService } from './mfa-secret-cipher.service';
import { RefreshTokenService } from './refresh-token.service';
import { TotpService } from './totp.service';

/**
 * High-level MFA orchestration. Composes the cipher, the RFC 6238
 * TOTP primitive, and the Prisma `MfaMethod` table into the four
 * surfaces that the controller actually calls:
 *
 *   - `beginEnrollment(userId, label?)` — generate a fresh TOTP
 *     secret, persist it (encrypted) as an *unconfirmed* method,
 *     return the otpauth URL the client renders as a QR.
 *
 *   - `confirmEnrollment(userId, methodId, code)` — take a code
 *     the user typed after scanning the QR, verify it against the
 *     unconfirmed method, flip `confirmedAt`, and toggle
 *     `users.mfaEnabled` to true.
 *
 *   - `verifyForChallenge(userId, code)` — used by the MFA verify
 *     endpoint during the second step of login. Walks the user's
 *     confirmed methods, returns the matched method id on success
 *     or null on failure. Updates `lastUsedAt` + `lastUsedStep` so
 *     a code cannot be replayed inside its own validity window.
 *
 *   - `listMethods(userId)` / `removeMethod(userId, methodId)` —
 *     management surfaces for the family / account screens.
 *
 * Single-method-per-user invariant. Phase 1 enforces at-most-one
 * confirmed method per user. Multi-device TOTP rolls forward when
 * recovery codes (TS-023-followup) and a "named" device list land —
 * having multiple confirmed methods now would surface a UX
 * ("which device do you mean?") that doesn't have an answer in the
 * current product. The single-method ceiling is encoded as an
 * explicit conflict in `confirmEnrollment`; multi-method paths
 * remain in the schema (`mfa_methods` accepts many rows per user)
 * so Phase 2 can lift the ceiling additively.
 *
 * Enabling/disabling MFA. `users.mfaEnabled` is the fast-path
 * boolean the login flow checks. It MUST agree with "user has at
 * least one confirmed, non-deleted method" — this service is the
 * sole writer of the column from the MFA side, and both
 * confirm/remove paths keep the invariant in a transaction.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: MfaSecretCipherService,
    private readonly totp: TotpService,
    /**
     * Session-rotation collaborator (TS-023-followup-5). Whenever
     * the user's MFA posture changes — `confirmEnrollment` first
     * confirms a method (flipping `users.mfa_enabled = true`) or
     * `removeMethod` retires one (potentially flipping the flag
     * back to false when the last confirmed method goes away) —
     * every outstanding refresh-token family for that user is
     * revoked in the same transaction. This closes the gap where
     * an attacker who has already established a session would
     * survive the user's MFA change. CLAUDE.md §3.1 spirit:
     * authentication-posture changes invalidate prior sessions.
     *
     * The revocation runs INSIDE the existing transaction so a
     * rollback on any leg unwinds the MFA write AND the
     * revocation together — "MFA changed AND sessions gone" is
     * the atomic invariant.
     */
    private readonly refreshTokens: RefreshTokenService,
    /**
     * One-time recovery codes (TS-023-followup-2). `confirmEnrollment`
     * mints a batch inside its transaction (so the codes commit
     * atomically with the method confirmation); `removeMethod`
     * invalidates the batch when the user's last confirmed method goes
     * away (recovery codes are meaningless with no MFA factor); and
     * `verifyRecoveryCode` consumes one on the recovery-verify login
     * path in lieu of a TOTP code.
     */
    private readonly recoveryCodes: MfaRecoveryCodeService,
  ) {}

  /**
   * Generate a fresh TOTP secret for the given user, persist it as
   * an unconfirmed method, return the otpauth URL the client must
   * render as a QR (and the secret in plain base32 as a fallback for
   * users typing it into a desktop authenticator).
   *
   * Reject if the user already has a confirmed method — Phase 1
   * single-method invariant.
   *
   * The unconfirmed method row is durable so a refresh of the
   * enrollment page can resume against the same secret rather than
   * regenerating one (which would invalidate any QR the user had
   * already scanned). To keep the table tidy under churn, an
   * unconfirmed method that's older than 24h can be safely pruned
   * by a future janitor; we do not auto-prune in the begin path
   * because that's surprising behaviour.
   */
  async beginEnrollment(args: {
    readonly userId: string;
    readonly accountLabel: string;
    readonly label?: string | undefined;
  }): Promise<{
    readonly methodId: string;
    readonly secretBase32: string;
    readonly otpauthUrl: string;
  }> {
    const existingConfirmed = await this.prisma.mfaMethod.findFirst({
      where: { userId: args.userId, confirmedAt: { not: null }, deletedAt: null },
      select: { id: true },
    });
    if (existingConfirmed !== null) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'A confirmed MFA method already exists for this account.',
      });
    }

    const secret = this.totp.generateSecret();
    const encrypted = this.cipher.encrypt(secret);

    const method = await this.prisma.mfaMethod.create({
      data: {
        userId: args.userId,
        kind: 'totp',
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        label: args.label ?? null,
      },
      select: { id: true },
    });

    const otpauthUrl = this.totp.buildOtpauthUrl({
      accountLabel: args.accountLabel,
      secretBase32: secret,
    });

    this.logger.log({ userId: args.userId, methodId: method.id }, 'mfa enrollment begun');

    return { methodId: method.id, secretBase32: secret, otpauthUrl };
  }

  /**
   * Verify a candidate code against an unconfirmed method, mark the
   * method confirmed, and toggle `users.mfaEnabled = true`.
   *
   * Two transactional writes happen atomically: the method row
   * update and the user row update. A future state where the user
   * has `mfaEnabled = true` but no confirmed method (or vice versa)
   * would break the login-branch contract.
   *
   * Recovery codes (TS-023-followup-2). On success a fresh batch of
   * single-use recovery codes is minted INSIDE the same transaction
   * (any stale batch from a prior enrollment is deleted first) and
   * returned in plaintext — the ONLY moment they exist in clear. The
   * caller surfaces them to the user exactly once; the server keeps
   * only hashes. Minting inside the transaction means a rollback on
   * any leg unwinds the codes too, so a user never ends up
   * MFA-enabled with no recovery codes (or vice versa).
   */
  async confirmEnrollment(args: {
    readonly userId: string;
    readonly methodId: string;
    readonly code: string;
  }): Promise<{ readonly recoveryCodes: readonly string[] }> {
    const method = await this.prisma.mfaMethod.findUnique({
      where: { id: args.methodId },
      select: {
        id: true,
        userId: true,
        kind: true,
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
        keyVersion: true,
        confirmedAt: true,
        deletedAt: true,
      },
    });

    if (
      method === null ||
      method.userId !== args.userId ||
      method.deletedAt !== null ||
      method.kind !== 'totp'
    ) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'MFA method not found.',
      });
    }

    if (method.confirmedAt !== null) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'MFA method is already confirmed.',
      });
    }

    const secret = this.cipher.decrypt({
      ciphertext: method.secretCiphertext,
      iv: method.secretIv,
      authTag: method.secretAuthTag,
      keyVersion: method.keyVersion,
    });

    const matchedStep = this.totp.verifyCode({
      secretBase32: secret,
      candidate: args.code,
    });

    if (matchedStep === null) {
      // Generic 400. We deliberately don't surface "wrong code" as a
      // distinct status from "code expired" — both are the same UX
      // outcome ("try again with a fresh code from your app"), and
      // collapsing them removes a small enumeration signal.
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Invalid MFA code.',
      });
    }

    type TxClient = {
      mfaMethod: PrismaService['mfaMethod'];
      user: PrismaService['user'];
      refreshToken: PrismaService['refreshToken'];
      mfaRecoveryCode: PrismaService['mfaRecoveryCode'];
    };
    const { revokedCount, recoveryCodes } = await this.prisma.$transaction(async (tx: TxClient) => {
      await tx.mfaMethod.update({
        where: { id: method.id },
        data: {
          confirmedAt: new Date(),
          lastUsedAt: new Date(),
          lastUsedStep: BigInt(matchedStep),
        },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: args.userId },
        data: { mfaEnabled: true },
        select: { id: true },
      });
      // Session rotation (TS-023-followup-5). Revoke every
      // outstanding refresh-token family for this user inside the
      // SAME transaction as the MFA write — if anything below
      // rolls back, the revocation rolls back too. This collapses
      // the "MFA changed but old sessions still alive" window to
      // zero. Idempotent on no-active-rows (a freshly-signed-up
      // user enrolling MFA right after signup has no sessions
      // yet, so this is a 0-row no-op write).
      const result = await this.refreshTokens.revokeAllFamiliesForUser(args.userId, { tx });
      // Recovery codes (TS-023-followup-2). Mint the batch inside
      // the same transaction so the codes commit atomically with
      // the confirmation. `generate` deletes any stale batch first
      // (idempotent re-enrol).
      const codes = await this.recoveryCodes.generate({ userId: args.userId, tx });
      return { revokedCount: result.revokedCount, recoveryCodes: codes };
    });

    this.logger.log(
      {
        userId: args.userId,
        methodId: method.id,
        revokedSessionFamilies: revokedCount,
        recoveryCodeCount: recoveryCodes.length,
      },
      'mfa enrollment confirmed',
    );

    return { recoveryCodes };
  }

  /**
   * Verify a presented recovery code as the second step of the login
   * flow, in lieu of a TOTP code, and consume it on success. Returns
   * true on success, false otherwise — the calling controller renders
   * any failure as a generic 401 (no enumeration).
   *
   * On success this emits the security-relevant signals a recovery-code
   * use warrants (CLAUDE.md §3.1, §3.6):
   *   - an audit-shaped structured log line (`mfa.recovery_code_used`)
   *     so the activity / audit log (TS-100) and trust & safety can
   *     surface "a backup code was used on your account";
   *   - a notification-intent log line so the "you used a recovery
   *     code" warning reaches the account owner via `service-notification`.
   *
   * Cross-service emission (the real `service-audit` outbox event +
   * `service-notification` dispatch) is carved as TS-023-followup-2a /
   * -2b — the same "structured log now, wire the cross-service pipe
   * when service-identity grows an outbox + notification client"
   * precedent the admin-mutation surface follows (TS-126-followup-5).
   */
  async verifyRecoveryCode(args: {
    readonly userId: string;
    readonly code: string;
  }): Promise<boolean> {
    const ok = await this.recoveryCodes.verifyAndConsume({
      userId: args.userId,
      code: args.code,
    });
    if (!ok) return false;

    const remaining = await this.recoveryCodes.countRemaining(args.userId);
    // Audit signal (CLAUDE.md §3.6). The structured shape mirrors what
    // the TS-100 audit-event schema validates against so the eventual
    // cross-service emission (TS-023-followup-2a) is a drop-in.
    this.logger.log(
      {
        event: 'mfa.recovery_code_used',
        userId: args.userId,
        recoveryCodesRemaining: remaining,
      },
      'mfa recovery code used — audit signal',
    );
    // Notification intent (CLAUDE.md §3.1 — alert the owner that a
    // backup code was used; PDD §12.1). Wired to a real
    // service-notification dispatch in TS-023-followup-2b.
    this.logger.log(
      { event: 'mfa.recovery_code_used.notify', userId: args.userId },
      'mfa recovery code used — notification intent',
    );
    return true;
  }

  /**
   * Verify a code against the user's confirmed methods, used as the
   * second step of the login flow. Returns true on success, false
   * otherwise. Updates `lastUsedAt` + `lastUsedStep` so a code
   * cannot be replayed inside its own ±window validity span.
   *
   * The replay-step guard is enforced at TWO layers:
   *   1. `TotpService.verifyCode` skips any candidate step ≤
   *      `lastUsedStep` before doing the HMAC compare.
   *   2. The DB UPDATE is conditional on the new step being strictly
   *      greater than the persisted `lastUsedStep` — a concurrent
   *      verify that picked the same step loses the race and is
   *      treated as a replay even though the code itself was valid.
   *
   * Either layer is sufficient on its own; combining them means the
   * window for a successful replay collapses to zero (single-row
   * UPDATE serialisation in Postgres is the second guarantee).
   */
  async verifyForChallenge(args: {
    readonly userId: string;
    readonly code: string;
  }): Promise<boolean> {
    const methods = await this.prisma.mfaMethod.findMany({
      where: { userId: args.userId, confirmedAt: { not: null }, deletedAt: null },
      select: {
        id: true,
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
        keyVersion: true,
        lastUsedStep: true,
      },
    });

    for (const method of methods) {
      const secret = this.cipher.decrypt({
        ciphertext: method.secretCiphertext,
        iv: method.secretIv,
        authTag: method.secretAuthTag,
        keyVersion: method.keyVersion,
      });
      const matchedStep = this.totp.verifyCode({
        secretBase32: secret,
        candidate: args.code,
        lastUsedStep: method.lastUsedStep === null ? null : Number(method.lastUsedStep),
      });
      if (matchedStep === null) continue;

      // Defence-in-depth: race-safe DB-level enforcement.
      const updateResult = await this.prisma.mfaMethod.updateMany({
        where: {
          id: method.id,
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(matchedStep) } }],
        },
        data: { lastUsedAt: new Date(), lastUsedStep: BigInt(matchedStep) },
      });
      if (updateResult.count === 0) {
        // Race lost → treat as replay. Continue to next method
        // rather than failing outright (a different method may have
        // a valid step).
        continue;
      }

      this.logger.log({ userId: args.userId, methodId: method.id }, 'mfa verify ok');
      return true;
    }

    this.logger.warn({ userId: args.userId }, 'mfa verify failed');
    return false;
  }

  /**
   * List the user's MFA methods (confirmed and unconfirmed, but not
   * soft-deleted). Returns a narrow projection — no secret material,
   * no key-version metadata.
   */
  async listMethods(userId: string): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly kind: 'totp' | 'sms_backup';
      readonly label: string | null;
      readonly confirmedAt: Date | null;
      readonly lastUsedAt: Date | null;
      readonly createdAt: Date;
    }>
  > {
    return this.prisma.mfaMethod.findMany({
      where: { userId, deletedAt: null },
      select: {
        id: true,
        kind: true,
        label: true,
        confirmedAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Soft-delete a method. If the deleted method was the user's last
   * confirmed method, also flip `users.mfaEnabled = false` to keep
   * the login-branch invariant.
   *
   * Throws 404 when the method does not exist for this user.
   */
  async removeMethod(args: { readonly userId: string; readonly methodId: string }): Promise<void> {
    const method = await this.prisma.mfaMethod.findUnique({
      where: { id: args.methodId },
      select: { id: true, userId: true, deletedAt: true, confirmedAt: true },
    });
    if (method === null || method.userId !== args.userId || method.deletedAt !== null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'MFA method not found.',
      });
    }

    type TxClient = {
      mfaMethod: PrismaService['mfaMethod'];
      user: PrismaService['user'];
      refreshToken: PrismaService['refreshToken'];
      mfaRecoveryCode: PrismaService['mfaRecoveryCode'];
    };
    const revokedCount = await this.prisma.$transaction(async (tx: TxClient) => {
      await tx.mfaMethod.update({
        where: { id: method.id },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
      const remainingConfirmed = await tx.mfaMethod.count({
        where: { userId: args.userId, confirmedAt: { not: null }, deletedAt: null },
      });
      if (remainingConfirmed === 0) {
        await tx.user.update({
          where: { id: args.userId },
          data: { mfaEnabled: false },
          select: { id: true },
        });
        // Recovery codes (TS-023-followup-2). The user's last confirmed
        // method is gone — MFA is now disabled, so the recovery codes
        // can no longer recover anything. Invalidate the whole batch
        // inside the same transaction so a re-enrol later starts from a
        // clean slate and a leaked-but-unused code can't be replayed
        // against a future MFA setup.
        await this.recoveryCodes.invalidateAll({ userId: args.userId, tx });
      }
      // Session rotation (TS-023-followup-5). Same rationale as
      // `confirmEnrollment` — a removed MFA method is an
      // authentication-posture change, so every outstanding
      // session is revoked atomically with the soft-delete.
      // Fires regardless of whether the deleted method was the
      // user's last confirmed one: removing ANY confirmed method
      // (e.g. one device of several in a future multi-method
      // world) is still a change worth invalidating sessions
      // over.
      const result = await this.refreshTokens.revokeAllFamiliesForUser(args.userId, { tx });
      return result.revokedCount;
    });

    this.logger.log(
      { userId: args.userId, methodId: method.id, revokedSessionFamilies: revokedCount },
      'mfa method removed',
    );
  }
}

/**
 * Helper used by tests + the controller (when looking up the user
 * for an MFA-required login that needs to know whether the account
 * has any confirmed methods).
 */
export async function userHasConfirmedMethod(
  prisma: PrismaService,
  userId: string,
): Promise<boolean> {
  const row = await prisma.mfaMethod.findFirst({
    where: { userId, confirmedAt: { not: null }, deletedAt: null },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Caller-provided exception types that the AuthService re-throws on
 * the MFA verify path so the controller can render a generic 401
 * without revealing whether the user has MFA configured.
 */
export class MfaCodeRejectedError extends UnauthorizedException {
  constructor() {
    super({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Invalid email or password.',
    });
  }
}
