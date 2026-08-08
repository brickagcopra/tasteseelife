import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannelKind } from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

import type {
  ChannelDispatchInput,
  ChannelDispatchOutcome,
  ChannelDispatcher,
} from './channel-dispatcher';

/**
 * SMS channel adapter (TS-073). Twilio is the Phase-1 SMS provider per
 * PDD §12.1.
 *
 * **Stub mode.** When `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
 * `NOTIFICATION_SMS_FROM_NUMBER` are missing the adapter logs +
 * returns a stub provider id. Live SDK wiring lands as TS-073-followup-2.
 *
 * **Recipient address validation.** Accepts E.164-shaped numbers
 * (`+` prefix, ≤ 16 chars including the `+`). Twilio's API will catch
 * malformed details; we just guard against obvious garbage at the
 * service layer.
 *
 * **SMS-segment splitting** stays out of scope here — Twilio handles
 * the GSM-7 vs UCS-2 segmenting based on body content.
 */
@Injectable()
export class SmsDispatcher implements ChannelDispatcher {
  public readonly channel: NotificationChannelKind = 'sms';
  private readonly logger = new Logger(SmsDispatcher.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async send(input: ChannelDispatchInput): Promise<ChannelDispatchOutcome> {
    if (!isLikelyE164(input.recipientAddress)) {
      return {
        status: 'failed',
        errorMessage: `recipientAddress does not look like an E.164 phone number: ${input.recipientAddress}`,
      };
    }

    if (input.rendered.kind !== 'sms') {
      return {
        status: 'failed',
        errorMessage: `sms dispatcher expected rendered.kind=sms, got ${input.rendered.kind}`,
      };
    }

    if (input.rendered.bodyText === null) {
      return {
        status: 'failed',
        errorMessage: `sms dispatcher expected rendered.bodyText to be populated`,
      };
    }

    const configured =
      this.env.TWILIO_ACCOUNT_SID &&
      this.env.TWILIO_AUTH_TOKEN &&
      this.env.NOTIFICATION_SMS_FROM_NUMBER;

    if (!configured) {
      this.logger.log(
        `[stub] sms dispatch dispatchId=${input.dispatchId} to=${input.recipientAddress} body_chars=${input.rendered.bodyText.length}`,
      );
      return { status: 'sent', providerMessageId: `stub-${input.dispatchId}`, liveMode: false };
    }

    // TS-073-followup-1b — credentials configured but no Twilio SDK wired yet
    // (that is TS-073-followup-2).
    //
    // This used to return `status: 'sent'` with a stub provider id, which
    // meant configuring the credentials moved the service from "obviously
    // sending nothing" to "recording every SMS as delivered while sending
    // nothing" — a `sent` row in `notification_dispatches` for a message that
    // never existed, and an outage invisible to every dashboard reading that
    // table. Deleted here ahead of the SDK work, and deliberately so: turning
    // the lie into a loud failure needs no Twilio account to validate, while
    // the live wiring does.
    this.logger.error(
      `sms dispatch dispatchId=${input.dispatchId} — Twilio credentials are configured but the live SDK is not wired (TS-073-followup-2); refusing to record an unsent message as sent`,
    );
    return {
      status: 'failed',
      errorMessage: 'twilio credentials configured but the live SMS transport is not wired',
    };
  }
}

/** Loose E.164 check — `+` prefix + 7..15 digits. */
function isLikelyE164(value: string): boolean {
  if (!value.startsWith('+')) return false;
  const rest = value.slice(1);
  if (rest.length < 7 || rest.length > 15) return false;
  return /^[0-9]+$/.test(rest);
}
