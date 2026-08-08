import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import jwt, { type SignOptions, type VerifyOptions } from 'jsonwebtoken';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * MFA challenge token shape.
 *
 *   sub     — user id the challenge is for
 *   jti     — primary key of the matching `identity.mfa_challenges`
 *             row; the consume path uses this to enforce single-use
 *   iat/exp — standard timestamps
 *   iss/aud — issuer + audience pinned (defence against token reuse
 *             across other JWT-bearing endpoints in the platform)
 *   pur     — explicit `mfa-challenge` purpose claim. Even if the
 *             access-token signing secret were ever accidentally
 *             reused for the challenge token (it MUST NOT be — see
 *             env.ts), an access-token verifier would reject this
 *             payload because `pur` is not a recognised access-token
 *             claim and the issuer / audience differ.
 */
export interface MfaChallengePayload {
  readonly sub: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
  readonly pur: 'mfa-challenge';
}

/**
 * Result of a `consume()` call.
 *
 * `ok: false` is not an exception because every failure mode is a
 * normal-flow outcome (token expired, replayed, signed under the
 * wrong key, malformed). Encoding them as branches forces explicit
 * controller handling per CLAUDE.md §2.1.
 */
export type MfaChallengeConsumeResult =
  | { readonly ok: true; readonly userId: string }
  | {
      readonly ok: false;
      readonly reason: 'invalid-signature' | 'expired' | 'replayed' | 'unknown';
    };

/**
 * Issues + consumes the short-lived MFA challenge JWT that gates the
 * second step of the login flow.
 *
 * Why a JWT rather than an opaque random string. The payload is small
 * and well-shaped, so signing avoids a DB lookup on every parse-and-
 * narrow path (we still need a DB lookup for single-use enforcement,
 * but not for "is this even the right shape"). It also keeps the JWT
 * machinery isolated from the access-token signing key — different
 * secret, different audience, different issuer (see env.ts threat
 * model).
 *
 * Why a separate signing secret from the access token. Compartment-
 * alisation: a leak of `JWT_ACCESS_SECRET` should not give an
 * attacker the ability to mint a "yes you cleared MFA" challenge that
 * bypasses the second factor. This is the same principle as not using
 * the same TLS cert for staging and production.
 *
 * Single-use enforcement. The JWT alone is bearer-replayable inside
 * its 5-minute TTL; we collapse the replay window to "first use wins"
 * by inserting a row in `identity.mfa_challenges` at issue time and
 * marking it consumed inside a transaction at verify time. The
 * single-use update is encoded as a conditional `updateMany` (WHERE
 * consumedAt IS NULL) so the second of two concurrent attempts sees
 * its own update affect 0 rows — no race window.
 */
@Injectable()
export class MfaChallengeTokenService {
  private readonly logger = new Logger(MfaChallengeTokenService.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Issue a fresh challenge token for a given user. Inserts the
   * tracking row first (so the row is durable BEFORE the token is
   * handed to the caller — a crash between insert and sign just
   * leaves an unused row that the janitor cleans up); signs the JWT
   * second.
   */
  async issue(args: {
    readonly userId: string;
    readonly ip?: string | undefined;
    readonly userAgent?: string | undefined;
  }): Promise<{
    readonly token: string;
    readonly expiresInSeconds: number;
    readonly expiresAt: Date;
    readonly jti: string;
  }> {
    const ttl = this.env.MFA_CHALLENGE_TTL_SECONDS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl * 1000);

    // `mfa_challenges.id` is a bare `@id` with NO database default — it is
    // the value the JWT carries as `jti`, so it has to be minted here and
    // written, not read back. The previous code omitted `id` and then used
    // `row.id`, which the generated client now correctly rejects; against a
    // real database that create raised "Argument `id` is missing" and every
    // MFA challenge issuance failed.
    const jti = randomUUID();

    const row = await this.prisma.mfaChallenge.create({
      data: {
        id: jti,
        userId: args.userId,
        expiresAt,
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
      },
      select: { id: true },
    });

    const payload: Omit<MfaChallengePayload, 'iat' | 'exp' | 'iss' | 'aud'> & {
      readonly pur: 'mfa-challenge';
    } = {
      sub: args.userId,
      jti: row.id,
      pur: 'mfa-challenge',
    };
    const options: SignOptions = {
      algorithm: 'HS256',
      expiresIn: ttl,
      issuer: this.env.JWT_ISSUER,
      audience: this.env.JWT_AUDIENCE,
    };
    const token = jwt.sign(payload, this.env.MFA_CHALLENGE_SECRET, options);

    return { token, expiresInSeconds: ttl, expiresAt, jti: row.id };
  }

  /**
   * Verify + consume a presented challenge token. Returns the user
   * id on success, a typed reason code otherwise. The JWT signature,
   * expiry, issuer, audience, and purpose are checked first; the DB
   * row's `consumedAt` is then atomically set inside a transaction —
   * if the conditional update affects 0 rows, the challenge was
   * already consumed and we return `replayed`.
   *
   * Failure modes are flattened to four typed reasons so the
   * controller can render a single 401 without leaking which one
   * applied to the network surface.
   */
  async consume(presentedToken: string): Promise<MfaChallengeConsumeResult> {
    const verifyOptions: VerifyOptions = {
      algorithms: ['HS256'],
      issuer: this.env.JWT_ISSUER,
      audience: this.env.JWT_AUDIENCE,
    };

    let decoded: unknown;
    try {
      decoded = jwt.verify(presentedToken, this.env.MFA_CHALLENGE_SECRET, verifyOptions);
    } catch (err) {
      if (isTokenExpiredError(err)) {
        return { ok: false, reason: 'expired' };
      }
      return { ok: false, reason: 'invalid-signature' };
    }

    if (!isMfaChallengePayload(decoded)) {
      return { ok: false, reason: 'invalid-signature' };
    }

    const { sub: userId, jti } = decoded;

    // Annotated with the generated `Prisma.TransactionClient` rather than a
    // hand-rolled `{ mfaChallenge: ... }` shape. The narrow shape did not
    // satisfy the interactive-transaction overload, so TypeScript resolved
    // `$transaction` to its array form and widened this function's return
    // type from the `MfaChallengeConsumeResult` discriminated union to a
    // bare `{ ok: boolean }` — losing the exhaustiveness the callers rely on.
    return this.prisma.$transaction(
      async (tx: PrismaTransactionClient): Promise<MfaChallengeConsumeResult> => {
        const row = await tx.mfaChallenge.findUnique({
          where: { id: jti },
          select: { id: true, userId: true, expiresAt: true, consumedAt: true },
        });

        if (row === null || row.userId !== userId) {
          // jti not in DB OR (defensively) doesn't match the signed
          // sub. The signed-sub mismatch should never happen unless the
          // challenge secret leaked — treat as `unknown`.
          return { ok: false, reason: 'unknown' as const };
        }

        const now = new Date();
        if (row.expiresAt.getTime() <= now.getTime()) {
          return { ok: false, reason: 'expired' as const };
        }

        if (row.consumedAt !== null) {
          // Already-consumed → replay attempt. Log warn (without the
          // jti — the jti is an unbounded user-supplied identifier, no
          // PII signal but unnecessary on the hot path).
          this.logger.warn({ userId }, 'mfa-challenge replay detected');
          return { ok: false, reason: 'replayed' as const };
        }

        // Atomic single-use mark: conditional update returns count 0
        // if another concurrent verify already consumed the row.
        const updateResult = await tx.mfaChallenge.updateMany({
          where: { id: jti, consumedAt: null },
          data: { consumedAt: now },
        });
        if (updateResult.count === 0) {
          // Race lost — the other side won. Surface as `replayed` so
          // the loser doesn't get a session.
          this.logger.warn({ userId }, 'mfa-challenge consume race lost');
          return { ok: false, reason: 'replayed' as const };
        }

        return { ok: true as const, userId };
      },
    );
  }
}

/**
 * Narrow an arbitrary decoded payload to the MFA challenge shape.
 *
 * We cannot rely on `jwt.verify` returning a particular object shape
 * — its return type is `string | JwtPayload | object` depending on
 * the input. Doing the narrow here keeps the callers free of casts.
 */
function isMfaChallengePayload(value: unknown): value is MfaChallengePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sub === 'string' &&
    typeof v.jti === 'string' &&
    typeof v.iat === 'number' &&
    typeof v.exp === 'number' &&
    typeof v.iss === 'string' &&
    typeof v.aud === 'string' &&
    v.pur === 'mfa-challenge'
  );
}

/**
 * Recognise `jsonwebtoken`'s `TokenExpiredError` without a hard
 * dependency on the value-side import (the library exports both the
 * class and the name; matching by `.name` is robust).
 */
function isTokenExpiredError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TokenExpiredError';
}
