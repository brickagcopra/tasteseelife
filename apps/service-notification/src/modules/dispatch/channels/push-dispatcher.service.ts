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
 * Push channel adapter (TS-073). Firebase Cloud Messaging covers both
 * Android (FCM) and iOS (FCM-via-APNs proxy) per PDD §12.1.
 *
 * **Stub mode.** When `FIREBASE_SERVICE_ACCOUNT_B64` /
 * `FIREBASE_PROJECT_ID` are missing the adapter logs + returns a stub
 * provider id. Live SDK wiring lands as TS-073-followup-3.
 *
 * **Recipient address.** The "address" for push is the FCM device
 * token registered when the mobile app installed (TS-310). FCM tokens
 * are opaque 152–256 char strings.
 */
@Injectable()
export class PushDispatcher implements ChannelDispatcher {
  public readonly channel: NotificationChannelKind = 'push';
  private readonly logger = new Logger(PushDispatcher.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async send(input: ChannelDispatchInput): Promise<ChannelDispatchOutcome> {
    if (!isLikelyFcmToken(input.recipientAddress)) {
      return {
        status: 'failed',
        errorMessage: `recipientAddress does not look like an FCM device token`,
      };
    }

    if (input.rendered.kind !== 'push') {
      return {
        status: 'failed',
        errorMessage: `push dispatcher expected rendered.kind=push, got ${input.rendered.kind}`,
      };
    }

    if (input.rendered.bodyText === null) {
      return {
        status: 'failed',
        errorMessage: `push dispatcher expected rendered.bodyText to be populated`,
      };
    }

    const configured = this.env.FIREBASE_SERVICE_ACCOUNT_B64 && this.env.FIREBASE_PROJECT_ID;

    if (!configured) {
      this.logger.log(
        `[stub] push dispatch dispatchId=${input.dispatchId} to=${input.recipientAddress.slice(0, 16)}... title=${input.rendered.subject ?? '(none)'}`,
      );
      return { status: 'sent', providerMessageId: `stub-${input.dispatchId}`, liveMode: false };
    }

    // TS-073-followup-1b — credentials configured but no firebase-admin SDK
    // wired yet (that is TS-073-followup-3). Same deleted lie as the SMS and
    // email adapters: this returned `status: 'sent'` with a stub provider id,
    // so a correctly-configured production pod recorded every push as
    // delivered while sending nothing.
    this.logger.error(
      `push dispatch dispatchId=${input.dispatchId} — Firebase credentials are configured but the live SDK is not wired (TS-073-followup-3); refusing to record an unsent message as sent`,
    );
    return {
      status: 'failed',
      errorMessage: 'firebase credentials configured but the live push transport is not wired',
    };
  }
}

function isLikelyFcmToken(value: string): boolean {
  // FCM tokens are typically 152+ chars; allow shorter (test fixtures)
  // but require non-empty + free of whitespace.
  if (value.length < 8 || value.length > 320) return false;
  return /^[A-Za-z0-9_:\-]+$/.test(value);
}
