import { Inject, Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { STRIPE_SDK_TOKEN } from '../stripe.constants';

/**
 * Reasons the verifier can reject a request. Surfaced to the controller
 * so it can return a precise (but still client-uninformative) HTTP status
 * code — see CLAUDE.md §3.9 (silent error swallowing) and §17.8 (Stripe
 * webhook signature discipline).
 *
 * `unknown` exists so a future Stripe SDK error mode that doesn't fit
 * any of the named branches still routes through the same negative path
 * (returns false from `verify`) without throwing across the controller
 * boundary.
 */
export type StripeWebhookVerificationFailure =
  | 'missing_signature_header'
  | 'invalid_signature'
  | 'invalid_payload_shape'
  | 'replay_outside_tolerance'
  | 'unknown';

/**
 * Success: the bytes were signed by Stripe with our webhook secret,
 * inside the configured replay window, and parse into a Stripe event
 * envelope.
 */
export interface StripeWebhookVerificationSuccess {
  readonly ok: true;
  /** The parsed Stripe event envelope (typed by the SDK). */
  readonly event: Stripe.Event;
  /** Wall-clock at which verification completed (for the persisted row). */
  readonly verifiedAt: Date;
}

/**
 * Failure: one of the reasons in `StripeWebhookVerificationFailure`. No
 * Stripe object is exposed because the SDK threw or no signature was
 * supplied.
 */
export interface StripeWebhookVerificationFailureResult {
  readonly ok: false;
  readonly reason: StripeWebhookVerificationFailure;
}

export type StripeWebhookVerificationResult =
  | StripeWebhookVerificationSuccess
  | StripeWebhookVerificationFailureResult;

/**
 * Wraps `stripe.webhooks.constructEvent` with a `Result`-shaped return
 * (no throw across the service boundary — CLAUDE.md §2.1 `Result<T, E>`
 * pattern for fallible operations).
 *
 * The whole point of this layer is to be the *only* place in the codebase
 * that calls `constructEvent`. Stripe's SDK does the HMAC-SHA256
 * computation against `(timestamp, payload)` and validates against the
 * comma-separated `t=...,v1=...` signature header; we do not re-implement
 * that math. We do enforce one thing on top: the request must carry a
 * Stripe-Signature header at all (the SDK's `constructEvent` would throw
 * `StripeSignatureVerificationError` for a missing header anyway, but
 * separating the branches gives ops a cleaner audit log).
 *
 * **Tolerance window** — the replay window in seconds is configured via
 * `STRIPE_WEBHOOK_TOLERANCE_SECONDS`. Stripe rejects events older than
 * the window relative to the local clock; if our pod's clock drifts more
 * than the window, every event becomes "old" and the service starts
 * returning 400. The default (300s / 5min) matches Stripe's SDK default;
 * the env caps it at [60s, 900s].
 *
 * **No payload logging** — the verifier never logs the raw body, the
 * signature header, or any Stripe-specific identifiers beyond the event
 * id and type on the success path. The body can contain PAN-adjacent
 * data (payment method `last4`, billing address) or PII (customer
 * email); logging it would breach CLAUDE.md §3.9 / §17.2.
 *
 * **Throws** only for misuse (programmer error): a non-`Buffer` raw body
 * means the raw-body parser is misconfigured upstream. That's an
 * invariant we want to surface loudly in test, not silently in prod.
 */
@Injectable()
export class StripeWebhookVerifierService {
  private readonly logger = new Logger(StripeWebhookVerifierService.name);

  constructor(
    @Inject(STRIPE_SDK_TOKEN) private readonly stripe: Stripe,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {}

  verify(args: {
    readonly rawBody: Buffer;
    readonly signatureHeader: string | string[] | undefined;
  }): StripeWebhookVerificationResult {
    const signature = normaliseSignature(args.signatureHeader);
    if (signature === null) {
      this.logger.warn({ reason: 'missing_signature_header' }, 'stripe webhook rejected');
      return { ok: false, reason: 'missing_signature_header' };
    }

    if (!Buffer.isBuffer(args.rawBody)) {
      // Misuse — the raw-body parser in main.ts must be wired before the
      // controller. Throwing here surfaces the misconfiguration in tests
      // and at startup smoke-tests rather than silently rejecting
      // legitimate Stripe events at runtime.
      throw new TypeError(
        'StripeWebhookVerifierService.verify expected a Buffer rawBody — the raw-body parser is not wired.',
      );
    }

    try {
      const event = this.stripe.webhooks.constructEvent(
        args.rawBody,
        signature,
        this.env.STRIPE_WEBHOOK_SECRET,
        this.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS,
      );
      const verifiedAt = new Date();
      this.logger.log(
        { eventId: event.id, eventType: event.type, livemode: event.livemode },
        'stripe webhook verified',
      );
      return { ok: true, event, verifiedAt };
    } catch (err) {
      const reason = classifyError(err);
      this.logger.warn(
        { reason, err: err instanceof Error ? err.message : 'unknown' },
        'stripe webhook rejected',
      );
      return { ok: false, reason };
    }
  }
}

function normaliseSignature(header: string | string[] | undefined): string | null {
  if (typeof header === 'string' && header.length > 0) {
    return header;
  }
  // Express may surface duplicate headers as an array; Stripe sends only
  // one, but we defensively accept the first non-empty entry. A request
  // with zero or only-empty entries is treated as "no signature".
  if (Array.isArray(header)) {
    const first = header.find(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
    return first ?? null;
  }
  return null;
}

function classifyError(err: unknown): StripeWebhookVerificationFailure {
  if (!(err instanceof Error)) {
    return 'unknown';
  }
  // Stripe's SDK throws `StripeSignatureVerificationError` (a subclass of
  // `StripeError`) for both bad-signature and replay-outside-tolerance
  // cases. The message text is the only signal that distinguishes them
  // — pattern-match defensively so a future SDK version with a richer
  // error type doesn't silently re-classify either branch.
  const name = err.name;
  const message = err.message.toLowerCase();
  if (name === 'StripeSignatureVerificationError') {
    if (message.includes('outside the tolerance')) {
      return 'replay_outside_tolerance';
    }
    return 'invalid_signature';
  }
  // `constructEvent` also throws when the body can't be parsed as JSON
  // (rare but possible if a buggy proxy mangles it).
  if (message.includes('unexpected token') || message.includes('not valid json')) {
    return 'invalid_payload_shape';
  }
  return 'unknown';
}
