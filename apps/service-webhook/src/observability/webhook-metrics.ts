import { Injectable } from '@nestjs/common';
import type {
  STRIPE_INVOICE_CHANGED,
  STRIPE_PAYMENT_METHOD_CHANGED,
  STRIPE_SUBSCRIPTION_CHANGED,
} from '@taste-and-see/contracts';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

import type { CheckrIngressOutcome } from '../modules/checkr/services/checkr-ingress.service';
import type { CheckrWebhookVerificationFailure } from '../modules/checkr/services/checkr-webhook-verifier.service';
import type { StripeIngressOutcome } from '../modules/stripe/services/stripe-ingress.service';
import type { StripeWebhookVerificationFailure } from '../modules/stripe/services/stripe-webhook-verifier.service';

const METER_NAME = 'service-webhook:webhook';

/**
 * Whether signature verification accepted (`ok`) or rejected (`reject`)
 * the inbound request. The `reject` arm always carries a precise reason
 * label; the `ok` arm carries the sentinel `none`.
 */
export type WebhookVerificationResult = 'ok' | 'reject';

/**
 * The three platform event names `service-webhook` relays Stripe billing
 * traffic under (TS-041a-followup-2). Typed from the contract constants
 * rather than restated as strings, so adding a fourth class of relayed event
 * without widening this label is a compile error at the call site.
 */
export type StripeRelayEventName =
  | typeof STRIPE_SUBSCRIPTION_CHANGED
  | typeof STRIPE_INVOICE_CHANGED
  | typeof STRIPE_PAYMENT_METHOD_CHANGED;

/**
 * Reason label for `stripe_webhook_verified_total`. On a reject it is the
 * verifier's `StripeWebhookVerificationFailure`; on accept it is `none`;
 * `missing_raw_body` covers the controller-level wiring-error branch
 * (the raw-body parser in `main.ts` didn't run) which short-circuits
 * before the verifier is consulted. All values are fixed string literals
 * — cardinality is bounded, no PII (CLAUDE.md §10).
 */
export type StripeVerificationReason =
  | StripeWebhookVerificationFailure
  | 'none'
  | 'missing_raw_body';

/** Checkr analogue of {@link StripeVerificationReason}. */
export type CheckrVerificationReason =
  | CheckrWebhookVerificationFailure
  | 'none'
  | 'missing_raw_body';

/**
 * Outcome label for `kyc_dispatch_total` (TS-026-followup-7). The first
 * three mirror the strings service-identity reports back over the
 * internal dispatch hop; the rest partition the `null`-returning failure
 * branches the bare return value collapses together:
 *
 *   - `applied` / `replayed` / `session_mismatch` — service-identity 2xx.
 *   - `skipped` — dispatch is a no-op (`KYC_DISPATCH_URL` unset, or the
 *     event type isn't `identity.verification_session.*`). No HTTP hop, so
 *     no latency sample.
 *   - `network_error` — `fetch` threw (connection refused, DNS, or the
 *     `AbortController` timeout fired).
 *   - `http_error` — service-identity returned a non-2xx status.
 *   - `bad_response` — 2xx body failed to parse as JSON, or carried an
 *     outcome string we don't recognise.
 *
 * All values are fixed string literals — cardinality is bounded, no PII
 * (CLAUDE.md §10).
 */
export type KycDispatchOutcome =
  | 'applied'
  | 'replayed'
  | 'session_mismatch'
  | 'skipped'
  | 'network_error'
  | 'http_error'
  | 'bad_response';

/**
 * Outcome label for `checkr_dispatch_total` (TS-051-followup-7). The
 * Checkr analogue of {@link KycDispatchOutcome}: the first three are the
 * strings service-provider reports back over the internal dispatch hop
 * (`applied` / `replayed` / `report_mismatch`); `skipped` is the no-op
 * (`BACKGROUND_CHECK_DISPATCH_URL` unset, the event isn't `report.*`, or
 * the event is missing the candidate id / status); `network_error` is a
 * thrown `fetch` (connection refused, DNS, or the `AbortController`
 * timeout); `http_error` is a non-2xx from service-provider; `bad_response`
 * is a 2xx body that failed to parse or carried an unknown outcome string.
 * All values are fixed string literals — cardinality is bounded, no PII
 * (CLAUDE.md §10).
 */
export type CheckrDispatchOutcome =
  | 'applied'
  | 'replayed'
  | 'report_mismatch'
  | 'skipped'
  | 'network_error'
  | 'http_error'
  | 'bad_response';

/**
 * service-webhook's domain Prometheus instruments (TS-041a-followup-4).
 *
 * Four counters span the two inbound surfaces (Stripe billing, Checkr
 * background checks); each surface gets a verified-result counter and a
 * persisted-outcome counter:
 *
 *   - `stripe_webhook_verified_total{result,reason}` — every inbound
 *     Stripe request, partitioned by accept/reject and the precise
 *     reject reason. A rising `result="reject"` rate is the leading
 *     indicator of a signing-secret rotation gone wrong (reason
 *     `invalid_signature`), pod clock drift (`replay_outside_tolerance`),
 *     or an attacker spraying the endpoint (`missing_signature_header`).
 *   - `stripe_webhook_persisted_total{outcome}` — first-time persistence
 *     vs. duplicate replay. Stripe retries on 5xx and on manual Dashboard
 *     "Resend", so a healthy steady-state has a non-trivial `duplicate`
 *     rate; a sudden all-`duplicate` window means upstream is replaying
 *     because our acks aren't landing.
 *   - `checkr_webhook_verified_total{result,reason}` — Checkr analogue.
 *   - `checkr_webhook_persisted_total{outcome}` — Checkr analogue.
 *
 * The KYC cross-service dispatch hop (TS-026-followup-7) adds:
 *
 *   - `kyc_dispatch_total{outcome}` — every `StripeIdentityKycDispatchService.dispatch`
 *     call, partitioned by the {@link KycDispatchOutcome}. A rising
 *     `http_error` / `network_error` rate means service-identity's internal
 *     route is unhealthy and rows are piling up undispatched (the pre-relay
 *     window); a rising `bad_response` rate is a contract drift between the
 *     two services.
 *   - `kyc_dispatch_duration_seconds{outcome}` — latency of the dispatch
 *     HTTP round-trip, recorded only for the branches that actually made a
 *     request (the `skipped` no-op carries no latency).
 *
 * `stripe_webhook_dispatch_lag_seconds` (named in the TS-041a-followup-4
 * acceptance) is deliberately NOT created here: the dispatch-lag signal
 * is only meaningful once the TS-142 outbox relay exists to drain
 * `dispatched_at IS NULL` rows. Today every persisted row stays
 * undispatched by design (the synchronous best-effort KYC /
 * background-check dispatch is a separate, pre-relay hop). The histogram
 * lands with the relay — carved as TS-041a-followup-4a.
 *
 * Label cardinality is bounded by construction — `result`, `reason`, and
 * `outcome` are all fixed string-literal unions, never derived from the
 * webhook payload (CLAUDE.md §10 PII discipline).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK. Mirrors the
 * `JanitorMetrics` domain-instrument shape (TS-022-followup-3a).
 */
@Injectable()
export class WebhookMetrics {
  private readonly stripeVerified: Counter;
  private readonly stripePersisted: Counter;
  private readonly checkrVerified: Counter;
  private readonly checkrPersisted: Counter;
  private readonly kycDispatch: Counter;
  private readonly kycDispatchDuration: Histogram;
  private readonly checkrDispatch: Counter;
  private readonly checkrDispatchDuration: Histogram;
  private readonly stripeRelayAppended: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.stripeVerified = meter.createCounter('stripe_webhook_verified_total', {
      description: 'Total inbound Stripe webhook requests, by verification result and reason',
    });
    this.stripePersisted = meter.createCounter('stripe_webhook_persisted_total', {
      description: 'Total verified Stripe events by persistence outcome (persisted / duplicate)',
    });
    this.checkrVerified = meter.createCounter('checkr_webhook_verified_total', {
      description: 'Total inbound Checkr webhook requests, by verification result and reason',
    });
    this.checkrPersisted = meter.createCounter('checkr_webhook_persisted_total', {
      description: 'Total verified Checkr events by persistence outcome (persisted / duplicate)',
    });
    this.kycDispatch = meter.createCounter('kyc_dispatch_total', {
      description: 'Total KYC cross-service dispatch attempts, by outcome',
    });
    this.kycDispatchDuration = meter.createHistogram('kyc_dispatch_duration_seconds', {
      description:
        'Latency of the KYC cross-service dispatch HTTP round-trip, in seconds, by outcome',
      unit: 's',
    });
    this.checkrDispatch = meter.createCounter('checkr_dispatch_total', {
      description: 'Total Checkr background-check cross-service dispatch attempts, by outcome',
    });
    this.checkrDispatchDuration = meter.createHistogram('checkr_dispatch_duration_seconds', {
      description:
        'Latency of the Checkr background-check cross-service dispatch HTTP round-trip, in seconds, by outcome',
      unit: 's',
    });
    this.stripeRelayAppended = meter.createCounter('stripe_relay_appended_total', {
      description:
        'Total allow-listed Stripe billing events appended to the outbox for relay, by platform event name',
    });
  }

  /** Record one inbound Stripe request's verification result + reason. */
  recordStripeVerification(
    result: WebhookVerificationResult,
    reason: StripeVerificationReason,
  ): void {
    this.stripeVerified.add(1, { result, reason });
  }

  /** Record a verified Stripe event's persistence outcome. */
  recordStripePersisted(outcome: StripeIngressOutcome): void {
    this.stripePersisted.add(1, { outcome });
  }

  /**
   * Record one Stripe billing event appended to the outbox for relay
   * (TS-041a-followup-2).
   *
   * **Only the relayed branch is counted.** The overwhelming majority of
   * inbound Stripe events are not on the relay allow-list, and counting
   * those as a `skipped` outcome would bury the three series that matter
   * under a number that is by design large and by design uninteresting —
   * an event we never intended to relay is not a relay outcome. Total
   * inbound volume is already `stripe_webhook_persisted_total`; the ratio
   * between the two is the alertable signal.
   *
   * `eventName` is one of three literals from the contract, never a Stripe
   * event type, so cardinality is three (CLAUDE.md §10).
   */
  recordStripeRelayAppended(eventName: StripeRelayEventName): void {
    this.stripeRelayAppended.add(1, { event_name: eventName });
  }

  /** Record one inbound Checkr request's verification result + reason. */
  recordCheckrVerification(
    result: WebhookVerificationResult,
    reason: CheckrVerificationReason,
  ): void {
    this.checkrVerified.add(1, { result, reason });
  }

  /** Record a verified Checkr event's persistence outcome. */
  recordCheckrPersisted(outcome: CheckrIngressOutcome): void {
    this.checkrPersisted.add(1, { outcome });
  }

  /**
   * Record one KYC dispatch outcome. `seconds` is supplied only for the
   * branches that actually made an HTTP request — the `skipped` no-op
   * passes it omitted so the latency histogram isn't polluted with
   * zero-duration samples that never left the process.
   */
  recordKycDispatch(outcome: KycDispatchOutcome, seconds?: number): void {
    this.kycDispatch.add(1, { outcome });
    if (seconds !== undefined) {
      this.kycDispatchDuration.record(seconds, { outcome });
    }
  }

  /**
   * Record one Checkr background-check dispatch outcome. `seconds` is
   * supplied only for the branches that actually made an HTTP request —
   * the `skipped` no-op passes it omitted so the latency histogram isn't
   * polluted with zero-duration samples that never left the process.
   * Mirrors {@link recordKycDispatch}.
   */
  recordCheckrDispatch(outcome: CheckrDispatchOutcome, seconds?: number): void {
    this.checkrDispatch.add(1, { outcome });
    if (seconds !== undefined) {
      this.checkrDispatchDuration.record(seconds, { outcome });
    }
  }
}
