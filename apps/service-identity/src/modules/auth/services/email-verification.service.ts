import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  EMAIL_VERIFICATION_PROBLEM_CODE,
  type VerifyEmailResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { EmailVerificationEmitter } from './email-verification-emitter';
import { VerificationResendCooldownService } from './verification-resend-cooldown.service';

/**
 * Email verification (TS-510).
 *
 * **The gap this closes.** `users.status` defaults to `pending_verification`
 * (TS-020) and `AuthService.login` requires `active`. Nothing anywhere moved
 * an account between the two — `admin/users/:id/reinstate` requires a current
 * status of `suspended`, so it could not either. Every account created through
 * the platform's own signup endpoint was permanently unable to log in. The
 * TS-505 E2E suite found it on its second run, which is the first time signup
 * and login had ever been exercised against each other as running processes.
 *
 * **Two surfaces, one mechanism.** A token is minted inside the signup
 * transaction and again on every explicit resend. Consuming any unexpired,
 * unspent token for a user flips that user to `active` and stamps
 * `email_verified_at`.
 *
 * **What this service refuses to tell the caller.**
 *
 *   - Every rejected verification is the same 400 with the same `detail`. The
 *     machine-readable `code` distinguishes invalid / expired / already-used
 *     because a client needs to choose between offering a resend and saying
 *     "you're already verified" — but an attacker holding a random string only
 *     ever sees `invalid_token`, so the finer codes are reachable only by
 *     someone who already holds a real token.
 *   - Resend returns 202 for every syntactically valid address: registered,
 *     unregistered, or already verified. Differentiating would make an
 *     unauthenticated endpoint a three-way account-enumeration oracle, the
 *     same reasoning that keeps signup's 409 from naming the field.
 *
 * **Verification does not mint a session.** Proving control of a mailbox is
 * not proving knowledge of the password, and a verification link is routinely
 * forwarded. The client's next step is the ordinary login it was going to make.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emitter: EmailVerificationEmitter,
    private readonly resendCooldown: VerificationResendCooldownService,
    @Inject(ENV_TOKEN) private readonly env: Env,
    /**
     * Injected clock. CLAUDE.md §9.3 forbids `sleep()` in tests, and expiry is
     * the whole behaviour here — a suite that cannot move time can only assert
     * the happy path.
     *
     * **`@Optional()` is load-bearing.** A default value does not stop Nest
     * injecting the parameter: it reads `design:paramtypes`, sees `Function`,
     * finds no provider for it, and the service fails to construct — which
     * takes the whole app down at boot, not at first use. `@Optional()` makes
     * Nest pass `undefined` so the default applies. Same defect as the four
     * sites TS-506 fixed in service-academy; caught here by the TS-505 fleet
     * refusing to start, because vitest emits no `design:paramtypes` and the
     * unit lane cannot see it.
     */
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Mint a token for a freshly created user, inside the caller's transaction.
   *
   * Called from `AuthService.signup`. Both the token row and the delivery
   * event are appended in that same transaction, so a rolled-back signup
   * leaves no token and mails nobody, and a committed signup can never be
   * left with no way to verify (CLAUDE.md §5.3).
   */
  async issueForSignup(
    tx: PrismaTransactionClient,
    user: { readonly id: string; readonly email: string },
  ): Promise<void> {
    await this.mint(tx, user, 'signup');
  }

  /**
   * Resend path. Always resolves; never reveals whether the address exists.
   *
   * A new token is minted rather than the outstanding one re-sent, because the
   * outstanding one is only held as a digest — re-sending it is not possible,
   * which is the point of storing it that way. Existing unspent tokens are
   * deliberately left spendable: invalidating them would break the link the
   * user may be clicking at this moment, and the mint is cheap.
   *
   * **Cooled down per address (TS-510-followup-3), before the account
   * lookup.** The address is attacker-chosen, so this endpoint is a lever for
   * mailing a stranger repeatedly from our sending domain; the gateway's
   * per-IP policy does not touch a distributed caller aimed at one inbox.
   * Claiming the window first — rather than after establishing that an
   * account exists — is what keeps the cooldown from becoming an enumeration
   * signal of its own, and stops the endpoint being usable to probe the user
   * table at all. A cooled-down call returns exactly as a permitted one does:
   * this method resolves either way and the controller's 202 is a constant.
   */
  async resend(rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();

    if (!(await this.resendCooldown.claim(email))) {
      // Debug, not warn, and no address: a second press of "send it again"
      // is ordinary user behaviour, and a warn per attempt would turn the
      // log into a list of addresses somebody asked about.
      this.logger.debug('verification resend suppressed by per-address cooldown');
      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, status: true, deletedAt: true },
    });

    if (user === null || user.deletedAt !== null || user.status !== 'pending_verification') {
      // Logged at debug, not warn: for an unverified-address typo this is the
      // expected outcome, and a warn per attempt would make the log a list of
      // addresses somebody probed.
      this.logger.debug('verification resend ignored — no pending account for the address');
      return;
    }

    await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      await this.mint(tx, { id: user.id, email: user.email }, 'resend');
    });

    this.logger.log({ userId: user.id }, 'verification email re-requested');
  }

  /**
   * Consume a token and activate the account.
   *
   * The whole flow is one transaction so the tombstone and the status flip
   * commit together: a token that has activated an account must never be
   * spendable again, and an account that flipped must have a spent token
   * explaining why.
   */
  async verify(rawToken: string): Promise<VerifyEmailResponse> {
    const tokenHash = hashToken(rawToken);
    const now = this.now();

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const token = await tx.emailVerificationToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          consumedAt: true,
        },
      });

      if (token === null) {
        throw rejection(EMAIL_VERIFICATION_PROBLEM_CODE.invalidToken);
      }
      if (token.consumedAt !== null) {
        throw rejection(EMAIL_VERIFICATION_PROBLEM_CODE.alreadyConsumed);
      }
      if (token.expiresAt.getTime() <= now.getTime()) {
        throw rejection(EMAIL_VERIFICATION_PROBLEM_CODE.expired);
      }

      const user = await tx.user.findUnique({
        where: { id: token.userId },
        select: { id: true, status: true, deletedAt: true, emailVerifiedAt: true },
      });

      // A token whose user is gone is indistinguishable from a forged one as
      // far as the caller is concerned — and the FK cascades, so this is only
      // reachable in the window where the row was deleted mid-request.
      if (user === null || user.deletedAt !== null) {
        throw rejection(EMAIL_VERIFICATION_PROBLEM_CODE.invalidToken);
      }

      // Spend the token first: the update is conditional on the tombstone
      // still being null, so two concurrent requests presenting the same token
      // cannot both proceed — the loser updates zero rows and is rejected as
      // already-consumed rather than silently double-activating.
      const spent = await tx.emailVerificationToken.updateMany({
        where: { id: token.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (spent.count === 0) {
        throw rejection(EMAIL_VERIFICATION_PROBLEM_CODE.alreadyConsumed);
      }

      // Verification confirms the mailbox; it does not resurrect an account
      // trust & safety suspended or the user closed. Those statuses are
      // decisions this endpoint has no authority to reverse, so the mailbox
      // fact is recorded and the status is left alone.
      const activate = user.status === 'pending_verification';

      const updated = await tx.user.update({
        where: { id: user.id },
        data: {
          ...(activate ? { status: 'active' as const } : {}),
          // Idempotent in spirit: keep the first verification's timestamp if
          // the address was somehow already verified under another token.
          emailVerifiedAt: user.emailVerifiedAt ?? now,
        },
        select: { id: true, status: true, emailVerifiedAt: true },
      });

      this.logger.log(
        { userId: updated.id, status: updated.status, activated: activate },
        'email verified',
      );

      return {
        userId: updated.id,
        status: updated.status,
        verifiedAt: (updated.emailVerifiedAt ?? now).toISOString(),
      };
    });
  }

  private async mint(
    tx: PrismaTransactionClient,
    user: { readonly id: string; readonly email: string },
    reason: 'signup' | 'resend',
  ): Promise<void> {
    const token = generateToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.env.EMAIL_VERIFICATION_TTL_SECONDS * 1_000);

    await tx.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt,
      },
      select: { id: true },
    });

    await this.emitter.emitRequested(tx, {
      userId: user.id,
      email: user.email,
      token,
      expiresAt,
      occurredAt: now,
      reason,
    });
  }
}

/**
 * 32 random bytes rendered base64url — 256 bits, URL-safe with no padding to
 * strip. Sized to be unguessable rather than to be typed by hand: it arrives
 * by link, and the alternative (a short code a user retypes) is a different
 * feature with a different threat model (rate limiting, lockout).
 */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256, base64url — the only form ever written to the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/**
 * All three rejections share status, title and `detail`. Only the `code`
 * differs, and only a caller who already holds a real token can reach anything
 * other than `invalid_token`.
 */
function rejection(code: string): BadRequestException {
  return new BadRequestException({
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    detail: 'That verification link is not valid. Request a new one to continue.',
    code,
  });
}
