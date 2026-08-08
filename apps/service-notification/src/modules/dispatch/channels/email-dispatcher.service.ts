import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannelKind } from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

import type {
  ChannelDispatchInput,
  ChannelDispatchOutcome,
  ChannelDispatcher,
} from './channel-dispatcher';
import { POSTMARK_CLIENT_TOKEN, type PostmarkEmailClient } from './postmark.constants';

/**
 * Email channel adapter (TS-073; live Postmark wiring TS-073-followup-1).
 * Postmark is the Phase-1 transactional provider per PDD §12.1
 * ("transactional email — Postmark / SES").
 *
 * **Stub mode.** When no Postmark client is provided (i.e.
 * `POSTMARK_SERVER_TOKEN` is unset — the dev / CI default) the adapter logs
 * the would-have-been-sent payload, skips the network call, and returns
 * `stub-<dispatchId>` with `liveMode: false`.
 *
 * **What TS-073-followup-1 actually fixed, and why it mattered more than
 * "the SDK wasn't wired".** The previous `[live-pending]` branch ran when
 * `POSTMARK_SERVER_TOKEN` *was* set — production — and returned
 * `status: 'sent'` with a stub id. So configuring the credential took the
 * platform from "obviously sending nothing" to "recording every
 * notification as delivered while sending nothing": a `sent` row in
 * `notification_dispatches` for mail that never existed, and an outage
 * invisible to every dashboard reading that table. A transport that cannot
 * send must FAIL, loudly. That is why the null-client branch below is a
 * `failed`, not a fall-back to stub.
 *
 * **Error taxonomy.** Postmark distinguishes two classes and they need
 * different human responses:
 *   - **Permanent** — `ErrorCode` 300 (invalid email address) and 406
 *     (inactive recipient: a hard bounce or spam complaint suppressed the
 *     address). Retrying is pointless; the recipient record is what has to
 *     change. Reported with the code so the row says which.
 *   - **Transient** — HTTP ≥ 500, rate limits, socket failures. The address
 *     is fine and the message is still owed.
 * Both land as `failed` because `ChannelDispatchOutcome` has no retry
 * discriminator today (TS-073 has no retry loop at all); the classification
 * is carried in the message so the distinction is legible to an operator and
 * is ready to become structured when a retry seam lands — see
 * TS-073-followup-1a.
 *
 * **Validation.** The adapter shape-checks the recipient address locally so
 * an obviously malformed one never costs a round trip; Postmark remains the
 * authority and its rejection is mapped above.
 */
@Injectable()
export class EmailDispatcher implements ChannelDispatcher {
  public readonly channel: NotificationChannelKind = 'email';
  private readonly logger = new Logger(EmailDispatcher.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    /**
     * `null` in stub mode. Injected rather than constructed here so a unit
     * test supplies a fake and never opens a socket, and so the decision
     * "are we live?" is made once, in the module factory, from the same
     * value that constructs the client.
     */
    @Inject(POSTMARK_CLIENT_TOKEN) private readonly postmark: PostmarkEmailClient | null,
  ) {}

  async send(input: ChannelDispatchInput): Promise<ChannelDispatchOutcome> {
    if (!isLikelyEmail(input.recipientAddress)) {
      return {
        status: 'failed',
        errorMessage: `recipientAddress does not look like an email: ${input.recipientAddress}`,
      };
    }

    if (input.rendered.kind !== 'email') {
      return {
        status: 'failed',
        errorMessage: `email dispatcher expected rendered.kind=email, got ${input.rendered.kind}`,
      };
    }

    if (!this.env.POSTMARK_SERVER_TOKEN) {
      this.logger.log(
        `[stub] email dispatch dispatchId=${input.dispatchId} to=${input.recipientAddress} subject=${input.rendered.subject ?? '(none)'}`,
      );
      return { status: 'sent', providerMessageId: `stub-${input.dispatchId}`, liveMode: false };
    }

    if (this.postmark === null) {
      // Credential configured but no client: a misconfiguration, and the one
      // state that must never read as success. Returning a stub `sent` here
      // is what TS-073-followup-1 existed to delete.
      this.logger.error(
        `email dispatch dispatchId=${input.dispatchId} — POSTMARK_SERVER_TOKEN is set but no Postmark client was provided; refusing to record an unsent message as sent`,
      );
      return {
        status: 'failed',
        errorMessage: 'postmark client unavailable despite POSTMARK_SERVER_TOKEN being configured',
      };
    }

    // Postmark requires at least one body. Catching it here names the real
    // fault ("the template rendered nothing") rather than surfacing a 422
    // whose ErrorCode would be classified as a generic transient failure and
    // retried forever against a template that will never produce a body.
    if (input.rendered.bodyHtml === null && input.rendered.bodyText === null) {
      return {
        status: 'failed',
        errorMessage: `template ${input.rendered.templateCode} rendered neither an HTML nor a text body`,
      };
    }

    try {
      const response = await this.postmark.sendEmail({
        From: formatFrom(input.fromName, input.fromAddress),
        To: input.recipientAddress,
        Subject: input.rendered.subject ?? '',
        ...(input.rendered.bodyHtml !== null && { HtmlBody: input.rendered.bodyHtml }),
        ...(input.rendered.bodyText !== null && { TextBody: input.rendered.bodyText }),
        // Postmark segregates transactional from broadcast traffic by stream;
        // sending on the wrong one puts a password reset behind a bulk
        // reputation. Every message this service sends today is
        // transactional (marketing is gated off entirely by the preference
        // layer), so the stream is pinned rather than derived — a derived
        // value would silently pick a stream for a category that has no
        // stream configured.
        MessageStream: POSTMARK_TRANSACTIONAL_STREAM,
      });

      this.logger.log(
        `email dispatch sent dispatchId=${input.dispatchId} providerMessageId=${response.MessageID}`,
      );
      return { status: 'sent', providerMessageId: response.MessageID, liveMode: true };
    } catch (cause) {
      const classified = classifyPostmarkError(cause);
      this.logger.warn(
        `email dispatch failed dispatchId=${input.dispatchId} kind=${classified.kind} ${classified.message}`,
      );
      return { status: 'failed', errorMessage: classified.message };
    }
  }
}

/**
 * Postmark's transactional message stream. `outbound` is the default stream
 * every Postmark server is created with.
 */
const POSTMARK_TRANSACTIONAL_STREAM = 'outbound';

/** Postmark `ErrorCode` for a syntactically or structurally invalid address. */
const POSTMARK_ERROR_INVALID_EMAIL = 300;

/**
 * Postmark `ErrorCode` for an INACTIVE recipient — the address hard-bounced
 * or filed a spam complaint and Postmark has suppressed it. Permanent by
 * definition: it stays suppressed until a human reactivates it.
 */
const POSTMARK_ERROR_INACTIVE_RECIPIENT = 406;

interface ClassifiedEmailError {
  readonly kind: 'permanent' | 'transient';
  readonly message: string;
}

/**
 * Map a thrown Postmark error to the permanent/transient split described on
 * the class.
 *
 * **Defaults to `transient`.** An unrecognised failure is far more likely to
 * be a new API error or a network fault than a permanently bad address, and
 * mistaking the two in that direction merely wastes a retry — whereas
 * calling a transient fault permanent abandons a message the platform owes
 * someone. `errorMessage` never carries the recipient address: this string
 * is persisted to `notification_dispatches` and read in admin surfaces, and
 * the address is already a column there (CLAUDE.md §3.9 — no PII widening).
 */
function classifyPostmarkError(cause: unknown): ClassifiedEmailError {
  const code = readNumber(cause, 'ErrorCode') ?? readNumber(cause, 'code');
  const status = readNumber(cause, 'statusCode') ?? readNumber(cause, 'status');

  if (code === POSTMARK_ERROR_INVALID_EMAIL) {
    return {
      kind: 'permanent',
      message: 'postmark rejected the recipient address as invalid (300)',
    };
  }
  if (code === POSTMARK_ERROR_INACTIVE_RECIPIENT) {
    return {
      kind: 'permanent',
      message:
        'postmark recipient is inactive — suppressed after a hard bounce or spam complaint (406)',
    };
  }
  if (status !== undefined && status >= 500) {
    return { kind: 'transient', message: `postmark upstream error (HTTP ${status})` };
  }
  if (status !== undefined && status === 429) {
    return { kind: 'transient', message: 'postmark rate limit (HTTP 429)' };
  }
  return {
    kind: 'transient',
    message: `postmark send failed${status === undefined ? '' : ` (HTTP ${status})`}${
      code === undefined ? '' : ` (ErrorCode ${code})`
    }`,
  };
}

/** Read a numeric property off an unknown thrown value without asserting `any`. */
function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Build the RFC 5322 `From` header. A display name containing a quote or a
 * backslash would break the quoted string, so those are stripped rather than
 * escaped — the name is our own configured value, not user input, and a
 * mangled header is a rejected send for every recipient at once.
 */
function formatFrom(name: string, address: string): string {
  const safeName = name.replace(/["\\]/g, '').trim();
  return safeName.length === 0 ? address : `"${safeName}" <${address}>`;
}

/** Loose email shape check — Postmark does the rigorous validation. */
function isLikelyEmail(value: string): boolean {
  if (value.length === 0 || value.length > 320) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at === value.length - 1) return false;
  if (value.indexOf('@', at + 1) !== -1) return false;
  return true;
}
