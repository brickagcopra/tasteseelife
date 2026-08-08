import { Injectable } from '@nestjs/common';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';

const METER_NAME = 'service-subscription:dunning';

/**
 * Outcome label shared across every DunningService instrument
 * (TS-042-followup-8). Each value maps 1:1 to a `DunningFailure.reason`
 * (`subscription_not_found` / `invalid_state` / `grace_not_expired` /
 * `invalid_request` / `stripe_unavailable`) plus `ok` for the success path
 * and `error` for the unexpected-throw catch-all — so a 500 is still
 * visible on the scrape surface rather than silently absent. All values
 * are fixed string literals: cardinality is bounded and no PII can land on
 * a metric label (CLAUDE.md §10, §17.2).
 */
export type DunningOutcome =
  | 'ok'
  | 'subscription_not_found'
  | 'invalid_state'
  | 'grace_not_expired'
  | 'invalid_request'
  | 'stripe_unavailable'
  /**
   * TS-042-followup-3 — the lifecycle event failed outbox validation and the
   * transaction was rolled back. Worth its own label rather than folding into
   * `error`: it is a contract/deploy skew (a producer running against a
   * registry that has moved), not an operational fault, and it should page a
   * different person.
   */
  | 'outbox_validation_failed'
  | 'error';

/**
 * The five logical dunning operations, used as the bounded `operation`
 * label on the shared latency histogram. Mirrors the public DunningService
 * surface 1:1.
 */
export type DunningOperation =
  | 'record_payment_failure'
  | 'record_payment_success'
  | 'exhaustion'
  | 'pause'
  | 'resume';

/**
 * Map a DunningFailure to its bounded `outcome` metric label.
 *
 * The parameter type is `{ reason: Exclude<DunningOutcome, 'ok'> }` rather
 * than an import of `DunningFailure` — this keeps `dunning-metrics.ts` free
 * of a runtime dependency on `dunning.service.ts` (avoiding an import
 * cycle) while still pinning the cardinality contract: the call site in
 * DunningService passes the real `DunningFailure`, so if a new failure
 * reason is ever added that is NOT also a `DunningOutcome` literal, the
 * call `dunningFailureOutcome(result.error)` fails to type-check. The label
 * space therefore cannot silently widen.
 */
export function dunningFailureOutcome(failure: {
  readonly reason: Exclude<DunningOutcome, 'ok'>;
}): DunningOutcome {
  return failure.reason;
}

/**
 * service-subscription's dunning-domain Prometheus instruments
 * (TS-042-followup-8).
 *
 * Five counters — one per DunningService surface — plus one shared latency
 * histogram:
 *
 *   - `dunning_payment_failure_total{outcome}` — every `recordPaymentFailure`
 *     call. A rising `invalid_state` rate means a webhook handler (or admin
 *     tool) is driving failures against subscriptions that can't accept them
 *     (already canceled / unpaid); a rising `subscription_not_found` rate
 *     points at a drifted Stripe→local mapping.
 *   - `dunning_payment_success_total{outcome,recovered}` — every
 *     `recordPaymentSuccess` call. The `recovered` boolean partitions the
 *     `ok` outcome into "this payment rescued a past_due/unpaid sub"
 *     (`recovered="true"`) vs a routine renewal (`recovered="false"`), so a
 *     dashboard can track dunning-recovery rate directly.
 *   - `dunning_exhaustion_total{outcome}` — every `applyDunningExhaustion`
 *     call (the sweeper entry point). `grace_not_expired` is the benign
 *     "swept too early" no-op; a healthy sweeper run shows mostly `ok` +
 *     `grace_not_expired`.
 *   - `dunning_pause_total{outcome}` / `dunning_resume_total{outcome}` — the
 *     two customer-facing pause/resume surfaces. A rising `stripe_unavailable`
 *     rate on either is the leading indicator of a Stripe outage or a rotated
 *     `STRIPE_SECRET_KEY`.
 *   - `dunning_operation_duration_seconds{operation,outcome}` — latency of
 *     each operation, bucketed by operation + outcome so the cheap
 *     short-circuits (`invalid_request` / `subscription_not_found`) don't
 *     skew the Stripe-round-trip histogram for `pause` / `resume`.
 *
 * Label cardinality is bounded by construction — `outcome` is a fixed
 * string-literal union, `operation` is the fixed five-value
 * {@link DunningOperation} set, and `recovered` is a stringified boolean.
 * No label is ever derived from a subscription id, customer id, Stripe id,
 * or any other PII (CLAUDE.md §3.9 / §10).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK. Mirrors the
 * `KycMetrics` (TS-026-followup-7) / `WebhookMetrics` (TS-041a-followup-4)
 * domain-instrument shape.
 */
@Injectable()
export class DunningMetrics {
  private readonly paymentFailure: Counter;
  private readonly paymentSuccess: Counter;
  private readonly exhaustion: Counter;
  private readonly pause: Counter;
  private readonly resume: Counter;
  private readonly duration: Histogram;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.paymentFailure = meter.createCounter('dunning_payment_failure_total', {
      description: 'Total dunning recordPaymentFailure calls, by outcome.',
    });
    this.paymentSuccess = meter.createCounter('dunning_payment_success_total', {
      description:
        'Total dunning recordPaymentSuccess calls, by outcome and whether the payment recovered a past_due/unpaid subscription.',
    });
    this.exhaustion = meter.createCounter('dunning_exhaustion_total', {
      description: 'Total dunning applyDunningExhaustion calls, by outcome.',
    });
    this.pause = meter.createCounter('dunning_pause_total', {
      description: 'Total subscription pause calls, by outcome.',
    });
    this.resume = meter.createCounter('dunning_resume_total', {
      description: 'Total subscription resume calls, by outcome.',
    });
    this.duration = meter.createHistogram('dunning_operation_duration_seconds', {
      description: 'Latency of dunning operations in seconds, by operation and outcome.',
      unit: 's',
    });
  }

  /** Record one `recordPaymentFailure` outcome (counter + latency). */
  recordPaymentFailure(outcome: DunningOutcome, seconds: number): void {
    this.paymentFailure.add(1, { outcome });
    this.recordDuration('record_payment_failure', outcome, seconds);
  }

  /** Record one `recordPaymentSuccess` outcome (counter + latency + recovered flag). */
  recordPaymentSuccess(outcome: DunningOutcome, recovered: boolean, seconds: number): void {
    this.paymentSuccess.add(1, { outcome, recovered: String(recovered) });
    this.recordDuration('record_payment_success', outcome, seconds);
  }

  /** Record one `applyDunningExhaustion` outcome (counter + latency). */
  recordExhaustion(outcome: DunningOutcome, seconds: number): void {
    this.exhaustion.add(1, { outcome });
    this.recordDuration('exhaustion', outcome, seconds);
  }

  /** Record one `pauseSubscription` outcome (counter + latency). */
  recordPause(outcome: DunningOutcome, seconds: number): void {
    this.pause.add(1, { outcome });
    this.recordDuration('pause', outcome, seconds);
  }

  /** Record one `resumeSubscription` outcome (counter + latency). */
  recordResume(outcome: DunningOutcome, seconds: number): void {
    this.resume.add(1, { outcome });
    this.recordDuration('resume', outcome, seconds);
  }

  private recordDuration(
    operation: DunningOperation,
    outcome: DunningOutcome,
    seconds: number,
  ): void {
    this.duration.record(seconds, { operation, outcome });
  }
}
