import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

export interface PruneVerificationTokensInput {
  readonly now: Date;
  /**
   * How long a spent or expired row is kept before deletion. Generous on
   * purpose — see the class doc-comment.
   */
  readonly retentionDays: number;
  /**
   * Upper bound on one tick's deletion. A first run against a long-lived
   * table would otherwise be a single unbounded `DELETE` holding locks on
   * a table the signup path writes to.
   */
  readonly batchSize: number;
}

export interface PruneVerificationTokensResult {
  readonly deletedCount: number;
  /** True when the batch cap was hit — more rows remain for the next tick. */
  readonly truncated: boolean;
}

/**
 * Prune spent and long-expired email-verification tokens
 * (TS-510-followup-1).
 *
 * `identity.email_verification_tokens` grows one row per signup and one
 * per resend, forever. Once a row is spent or well past its expiry it has
 * no further use: **the durable record that an address was verified is
 * `users.email_verified_at`, not the token.** The token row is a
 * short-lived capability, and keeping capabilities after they expire is
 * how a table becomes a liability rather than an asset.
 *
 * **Retention is deliberately generous** (30 days by default, long after
 * a token's own TTL of hours). The rows are kept not because the platform
 * needs them but because a support question does — "did the link we sent
 * you on Tuesday work?" is answerable from `consumed_at`, and a prune
 * tuned to the token's lifetime would delete the answer while the
 * question is still being asked.
 *
 * **Deletes in bounded batches.** `email_verification_tokens` is written
 * by the signup transaction, so an unbounded `DELETE` on a first run
 * against a long-lived table would hold locks across a path where latency
 * is a customer sitting at a form. The runner does one batch per tick and
 * reports whether more remain; the sweep is idempotent and the backlog
 * drains over subsequent ticks rather than in one stall.
 *
 * **Both predicates, in one pass.** A spent row and an expired-unspent
 * row are equally useless after the window, and they overlap (a token can
 * be spent *and* long past expiry). Expressing them as one `OR` rather
 * than two sweeps means a row is never counted twice and the batch cap
 * means what it says.
 *
 * The cutoff applies to **`created_at`**, not to `consumed_at` or
 * `expires_at`. Those two answer different questions and one of them is
 * null on every unspent row; `created_at` is the one column present on
 * every row, monotonic, and the thing a support question is actually
 * anchored to ("the link we sent you on Tuesday").
 */
@Injectable()
export class VerificationTokenPruneService {
  private readonly logger = new Logger(VerificationTokenPruneService.name);

  constructor(private readonly prisma: PrismaService) {}

  async prune(input: PruneVerificationTokensInput): Promise<PruneVerificationTokensResult> {
    const cutoff = new Date(input.now.getTime() - input.retentionDays * 86_400_000);

    // Select ids first, then delete by id. `deleteMany` has no `take`, and
    // an unbounded delete is exactly what the batch cap exists to avoid.
    const doomed = await this.prisma.emailVerificationToken.findMany({
      where: {
        createdAt: { lt: cutoff },
        OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: input.now } }],
      },
      select: { id: true },
      take: input.batchSize,
      // Oldest first: a backlog drains in the order it accumulated, and a
      // partial run leaves the most recently useful rows behind.
      orderBy: { createdAt: 'asc' },
    });

    if (doomed.length === 0) {
      return { deletedCount: 0, truncated: false };
    }

    const { count } = await this.prisma.emailVerificationToken.deleteMany({
      where: { id: { in: doomed.map((row) => row.id) } },
    });

    // `count` can be lower than `doomed.length` if a concurrent tick or a
    // cascading user delete got there first. That is benign, and reporting
    // the ACTUAL number is what keeps the metric honest.
    if (count !== doomed.length) {
      this.logger.debug(
        { selected: doomed.length, deleted: count },
        'verification-token prune deleted fewer rows than selected (concurrent delete)',
      );
    }

    return { deletedCount: count, truncated: doomed.length === input.batchSize };
  }
}
