import { Injectable } from '@nestjs/common';
import { IdentityEmailVerificationRequestedSchema } from '@taste-and-see/contracts';

import {
  EmailVerificationMailerService,
  type VerificationMailOutcome,
} from '../email-verification-mailer.service';

import type { OutboxHandlerArgs } from './dunning.handlers';

/**
 * `identity.email_verification_requested` → the verification email
 * (TS-510-followup-4).
 *
 * Thin by design: parse, hand off. The parse is not redundant with the
 * relay's — producer and consumer are separate deploys, and a skew where a
 * field is missing is precisely when a Zod failure should redeliver rather
 * than let an `undefined` reach a template.
 *
 * **A parse failure must not include the payload in its message.** Zod's
 * default error carries the failing value, and the failing value here
 * contains a live token — so the raw error is deliberately swallowed and
 * replaced. The event id is enough to find the row.
 */
@Injectable()
export class IdentityEmailVerificationRequestedHandler {
  constructor(private readonly mailer: EmailVerificationMailerService) {}

  async handle(args: OutboxHandlerArgs): Promise<VerificationMailOutcome> {
    const parsed = IdentityEmailVerificationRequestedSchema.safeParse(args.payload);
    if (!parsed.success) {
      // No `cause`, no issues array, no payload — all three would carry
      // the token or the address (CLAUDE.md §3.1).
      throw new Error(
        'identity.email_verification_requested payload failed validation (details withheld: the payload carries a live token)',
      );
    }

    const event = parsed.data;
    return this.mailer.deliver({
      eventId: event.eventId,
      userId: event.userId,
      email: event.email,
      token: event.token,
      expiresAt: event.expiresAt,
      occurredAt: event.occurredAt,
      isResend: event.reason === 'resend',
    });
  }
}
