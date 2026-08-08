import type { NotificationChannelKind, RenderTemplateResponse } from '@taste-and-see/contracts';

/**
 * Pluggable strategy interface for a channel dispatcher (TS-073).
 *
 * `DispatchOrchestratorService` picks an implementation by channel kind
 * and hands off the rendered template + recipient address. Each
 * implementation returns a discriminated outcome — `sent` (with a
 * provider message id) or `failed` (with an error message).
 *
 * **Stub-mode default.** Phase-1 adapters operate in stub mode unless
 * the matching env credentials are present:
 *   - Email needs `POSTMARK_SERVER_TOKEN`.
 *   - SMS needs `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` +
 *     `NOTIFICATION_SMS_FROM_NUMBER`.
 *   - Push needs `FIREBASE_SERVICE_ACCOUNT_B64` + `FIREBASE_PROJECT_ID`.
 *
 * In stub mode the adapter logs the would-have-been-sent payload, skips
 * the network call, and returns a deterministic `stub-<dispatch-id>`
 * provider id. Live SDK wiring lands as TS-073-followup-N (one per
 * channel) — see Pending_tasks.md.
 */
export interface ChannelDispatcher {
  readonly channel: NotificationChannelKind;
  send(input: ChannelDispatchInput): Promise<ChannelDispatchOutcome>;
}

export interface ChannelDispatchInput {
  /** Stable dispatch id; the adapter may use it as a stub provider id. */
  readonly dispatchId: string;
  readonly recipientAddress: string;
  readonly rendered: RenderTemplateResponse;
  readonly fromAddress: string;
  readonly fromName: string;
}

export type ChannelDispatchOutcome =
  | {
      readonly status: 'sent';
      readonly providerMessageId: string;
      readonly liveMode: boolean;
    }
  | {
      readonly status: 'failed';
      readonly errorMessage: string;
    };
