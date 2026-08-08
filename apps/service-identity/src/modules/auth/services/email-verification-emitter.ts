import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  IDENTITY_EMAIL_VERIFICATION_REQUESTED,
  type IdentityEmailVerificationRequested,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

/**
 * Outbox producer for `identity.email_verification_requested` (TS-510).
 *
 * Same in-transaction append shape as `RbacExpiryEmitter` — call
 * `emitRequested(tx, …)` from inside the transaction that persists the token
 * hash, so the delivery signal and the token commit together (CLAUDE.md §5.3).
 * The relay already drains `identity.outbox_events`; a new event name on the
 * same table needs no relay-config change.
 *
 * **A failed append rolls the mint back.** This throws rather than logging and
 * continuing: a token that exists with no queued delivery is a user who signed
 * up, was told to check their email, and will never receive anything. Failing
 * the signup is recoverable — the user retries. A silent orphan is not.
 *
 * **The payload carries the raw token**, which is unavoidable: the event exists
 * to deliver it. See the credential note in the contract's file header for the
 * bounds that make that acceptable, and note the consumer's obligation not to
 * log the payload.
 */
@Injectable()
export class EmailVerificationEmitter {
  private readonly logger = new Logger(EmailVerificationEmitter.name);

  constructor(private readonly outbox: OutboxService) {}

  async emitRequested(
    tx: OutboxRawExecutor,
    descriptor: {
      readonly userId: string;
      readonly email: string;
      readonly token: string;
      readonly expiresAt: Date;
      readonly occurredAt: Date;
      readonly reason: 'signup' | 'resend';
    },
  ): Promise<void> {
    const eventId = randomUUID();
    const payload: IdentityEmailVerificationRequested = {
      eventId,
      occurredAt: descriptor.occurredAt.toISOString(),
      userId: descriptor.userId,
      email: descriptor.email,
      token: descriptor.token,
      expiresAt: descriptor.expiresAt.toISOString(),
      reason: descriptor.reason,
    };

    const result = await this.outbox.append(tx, {
      eventName: IDENTITY_EMAIL_VERIFICATION_REQUESTED,
      payload,
      eventId,
      occurredAt: descriptor.occurredAt,
    });

    if (result.kind !== 'appended') {
      throw new EmailVerificationEmitFailedError(descriptor.userId, result.issues);
    }

    // `userId` and `reason` only — never the token, never the address
    // (CLAUDE.md §3.1: never log a full token; §3.9: no unredacted PII).
    this.logger.log(
      { userId: descriptor.userId, reason: descriptor.reason, eventId },
      'identity.email_verification_requested emitted',
    );
  }
}

export class EmailVerificationEmitFailedError extends Error {
  constructor(
    readonly userId: string,
    readonly issues: unknown,
  ) {
    super(
      `Failed to append identity.email_verification_requested for user ${userId}: ${JSON.stringify(issues)}`,
    );
    this.name = 'EmailVerificationEmitFailedError';
  }
}
