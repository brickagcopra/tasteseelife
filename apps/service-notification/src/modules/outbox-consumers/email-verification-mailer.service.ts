import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_CODE,
  ACCOUNT_VERIFICATION_TEMPLATE_CATEGORY,
  ACCOUNT_VERIFICATION_TEMPLATE_LOCALE,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { DispatchOrchestratorService } from '../dispatch/services/dispatch-orchestrator.service';

/**
 * Outcomes of one verification-mail attempt. A union rather than
 * `void`/`throw` for the same reason the dunning ladder has one: a mail
 * that is deliberately not sent must be distinguishable from one that
 * failed, and both must be visible.
 */
export type VerificationMailOutcome =
  | { readonly kind: 'sent'; readonly replayed: boolean }
  /** The token had already expired before we got to it. */
  | { readonly kind: 'skipped_expired' };

export interface DeliverVerificationInput {
  readonly eventId: string;
  readonly userId: string;
  readonly email: string;
  /** LIVE SINGLE-USE CREDENTIAL. Never log this, or anything built from it. */
  readonly token: string;
  readonly expiresAt: string;
  readonly occurredAt: string;
  readonly isResend: boolean;
}

/**
 * Renders and sends the account email-verification message
 * (TS-510-followup-4).
 *
 * **Nothing here may log the token, the URL built from it, or the rendered
 * body** (CLAUDE.md §3.1). Every log line below carries ids, the address's
 * domain and an outcome — never the secret. This is not a precaution about
 * an unlikely leak: the mail body *is* the credential, so the usual
 * "log the payload on failure" reflex would write working account-takeover
 * links into the log aggregator.
 *
 * The email address is logged as its **domain only**. A full address is
 * PII (§3.9) and the operational question a log answers — "are all the
 * failures at one mail provider?" — is answered by the domain.
 */
@Injectable()
export class EmailVerificationMailerService {
  private readonly logger = new Logger(EmailVerificationMailerService.name);

  constructor(
    private readonly dispatcher: DispatchOrchestratorService,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  async deliver(input: DeliverVerificationInput): Promise<VerificationMailOutcome> {
    const expiresAt = new Date(input.expiresAt);
    const occurredAt = new Date(input.occurredAt);

    // A redelivery days later, or a consumer catching up after an outage,
    // would otherwise mail a link that is dead on arrival — which reads to
    // the recipient as a broken product rather than a stale message. WARN,
    // not log: reaching here at all means the consumer fell far enough
    // behind that new customers went unmailed.
    if (expiresAt.getTime() <= Date.now()) {
      this.logger.warn(
        {
          eventId: input.eventId,
          userId: input.userId,
          emailDomain: domainOf(input.email),
          expiresAt: input.expiresAt,
        },
        'email-verification.skipped-expired',
      );
      return { kind: 'skipped_expired' };
    }

    const result = await this.dispatcher.dispatch({
      recipientUserId: input.userId,
      channel: 'email',
      category: ACCOUNT_VERIFICATION_TEMPLATE_CATEGORY,
      templateCode: ACCOUNT_EMAIL_VERIFICATION_TEMPLATE_CODE,
      locale: ACCOUNT_VERIFICATION_TEMPLATE_LOCALE,
      // From the EVENT, not from a lookup. service-notification must not
      // read `identity.users` (CLAUDE.md §17.3), and the address is on the
      // payload precisely so it does not have to.
      recipientAddress: input.email,
      variables: {
        appName: this.env.DUNNING_APP_NAME,
        verificationUrl: this.buildVerificationUrl(input.token),
        expiresInLabel: expiresInLabel(occurredAt, expiresAt),
        isResend: input.isResend,
      },
      // **The one message on this platform that bypasses quiet hours.**
      // Someone is sitting at a signup form waiting for it; holding it
      // until morning breaks the flow they are in the middle of, and the
      // link expires in hours. The dunning ladder makes the opposite call
      // for the opposite reason.
      bypassQuietHours: true,
      // One send per event. A resend is a NEW event with a new id, so it
      // is not deduped against the first — which is the whole point of
      // pressing "send it again".
      idempotencyKey: `email-verification:${input.eventId}`,
      sourceEventId: input.eventId,
    });

    this.logger.log(
      {
        eventId: input.eventId,
        userId: input.userId,
        emailDomain: domainOf(input.email),
        isResend: input.isResend,
        replayed: result.replayed,
      },
      'email-verification.dispatched',
    );

    return { kind: 'sent', replayed: result.replayed };
  }

  /**
   * `{base}?token={token}`, with the base coming from config and never
   * from the event — a producer that could name the destination would let
   * anyone who could forge an event point a real verification link at
   * their own host.
   *
   * Built with `URL` rather than string concatenation so a base that
   * already carries a query string or a trailing slash cannot silently
   * produce a broken link, and so the token is percent-encoded.
   */
  private buildVerificationUrl(token: string): string {
    const url = new URL(this.env.EMAIL_VERIFICATION_URL_BASE);
    url.searchParams.set('token', token);
    return url.toString();
  }
}

/**
 * Duration phrased for a reader — "24 hours", "45 minutes". Never a
 * timestamp: an absolute instant in an email invites the reader to
 * compare it against a clock in the wrong time zone, and the only thing
 * they need to know is roughly how long they have.
 *
 * Rounds DOWN, so the promise is never longer than the truth.
 */
function expiresInLabel(from: Date, to: Date): string {
  const totalMinutes = Math.floor((to.getTime() - from.getTime()) / 60_000);
  if (totalMinutes < 1) return 'a few moments';
  if (totalMinutes < 60) return plural(totalMinutes, 'minute');

  const hours = Math.floor(totalMinutes / 60);
  if (hours < 48) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

function plural(value: number, unit: string): string {
  return `${String(value)} ${unit}${value === 1 ? '' : 's'}`;
}

/**
 * The part of an address that is safe to log. Everything before `@`
 * identifies a person; the domain answers the operational question.
 */
function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? 'unknown' : email.slice(at + 1);
}
