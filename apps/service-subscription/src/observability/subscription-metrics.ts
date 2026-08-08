import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

const METER_NAME = 'service-subscription:subscription';

/**
 * The object class a relayed Stripe event reconciled. One label rather than
 * one counter per class, so a dashboard can total "Stripe reconciliations" and
 * still break it down (TS-140-followup-4's lesson: one measurement, one name).
 */
export type StripeReconcileObject = 'subscription' | 'invoice' | 'payment_method';

/**
 * Every way a reconciliation can end. Restated here as a closed union rather
 * than taking `string`, so the counter cannot grow an unbounded label set the
 * day someone passes an error message through — the failure mode that turns a
 * counter into a cardinality incident. `ReconcileOutcome['kind']` is
 * assignable to it, so the reconciler's own union stays the source of truth
 * and a new arm there is a compile error here.
 */
export type StripeReconcileOutcome =
  | 'reconciled'
  | 'no_change'
  | 'not_tracked'
  /** Invoice belonging to no subscription — not representable locally. */
  | 'one_off'
  /** Stripe payment-method type this platform has no `kind` for. */
  | 'unknown_kind'
  | 'stripe_missing'
  | 'unknown_status'
  | 'mode_mismatch';

/**
 * Domain instruments for `service-subscription` (TS-041b-followup-3a).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op meter
 * when `initMetrics` was never called — so this class is safe to construct in
 * unit tests without booting the SDK. Mirrors `WebhookMetrics` /
 * `BookingMetrics`.
 */
@Injectable()
export class SubscriptionMetrics {
  private readonly stripeReconcile: Counter;
  private readonly dunningBridge: Counter;
  private readonly dunningExhaustionSweep: Counter;
  private readonly dunningExhaustionSweepTicks: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.stripeReconcile = meter.createCounter('subscription_stripe_reconcile_total', {
      description:
        'Relayed Stripe events reconciled against local rows, by object class and outcome',
    });
    this.dunningBridge = meter.createCounter('subscription_stripe_dunning_bridge_total', {
      description:
        'Relayed Stripe invoice outcomes routed into the dunning state machine, by outcome',
    });
    this.dunningExhaustionSweep = meter.createCounter('subscription_dunning_exhaustion_total', {
      description:
        'Subscriptions seen by the dunning-exhaustion sweep, by per-subscription outcome',
    });
    this.dunningExhaustionSweepTicks = meter.createCounter(
      'subscription_dunning_exhaustion_ticks_total',
      {
        description: 'Dunning-exhaustion sweep ticks, labelled by whether the batch was truncated',
      },
    );
  }

  /**
   * Record one relayed-Stripe-event reconciliation.
   *
   * **The non-happy outcomes are why this counter exists.** `reconciled` and
   * `no_change` are both healthy — a redelivery producing `no_change` is the
   * converging design working. The three that want a human are
   * `not_tracked` (a Stripe object nobody on this platform owns — a trickle is
   * normal for out-of-band Dashboard activity, a spike means our creates are
   * failing to write their local row), `stripe_missing` (a local row pointing
   * at a subscription Stripe no longer serves) and `unknown_status` (Stripe
   * shipped a status this platform cannot name, and rows are silently going
   * stale until someone maps it). `mode_mismatch` is a deploy error: a pod
   * holding a test key is being fed live traffic, or the reverse.
   *
   * Cardinality is bounded by construction — both labels are fixed string
   * unions, never derived from a Stripe payload (CLAUDE.md §10).
   */
  recordStripeReconcile(object: StripeReconcileObject, outcome: StripeReconcileOutcome): void {
    this.stripeReconcile.add(1, { object, outcome });
  }

  /**
   * Record one relayed invoice event routed into `DunningService`
   * (TS-042-followup-4).
   *
   * **`skipped` is deliberately NOT recorded by the caller.** Most relayed
   * invoice events are not dunning signals — `created`, `finalized`,
   * `voided` — and counting them would bury `applied` under a number that is
   * by design large and by design uninteresting, the same reasoning that keeps
   * `stripe_relay_appended_total` to the relayed branch only. The three
   * recorded outcomes are the ones that describe something happening or
   * failing to.
   *
   * `rejected` is the one to watch: it means `DunningService` refused a real
   * payment failure — usually because the subscription is in a state dunning
   * does not act on — and a family's declined card produced no grace window.
   */
  recordDunningBridge(outcome: Exclude<DunningBridgeMetricOutcome, 'skipped'>): void {
    this.dunningBridge.add(1, { outcome });
  }

  /**
   * Record one dunning-exhaustion sweep tick (TS-042-followup-2).
   *
   * **Every counter is recorded on every tick, including the zeros.** A gauge
   * that only appears when the sweep finds something is indistinguishable from
   * a sweep that stopped running — the failure mode TS-306-followup-1a named.
   * A tick that reports `candidates: 0` is the signal that the sweep is alive
   * and the dunning pipeline is healthy.
   *
   * `truncated` is a separate counter rather than a label, because it is not a
   * property of the subscriptions swept — it is a property of the tick, and a
   * non-zero rate on it means a backlog an operator should look at.
   */
  recordDunningExhaustionSweep(result: {
    readonly candidates: number;
    readonly exhausted: number;
    readonly skipped: number;
    readonly failed: number;
    readonly truncated: boolean;
  }): void {
    this.dunningExhaustionSweep.add(result.candidates, { outcome: 'candidate' });
    this.dunningExhaustionSweep.add(result.exhausted, { outcome: 'exhausted' });
    this.dunningExhaustionSweep.add(result.skipped, { outcome: 'skipped' });
    this.dunningExhaustionSweep.add(result.failed, { outcome: 'failed' });
    this.dunningExhaustionSweepTicks.add(1, { truncated: String(result.truncated) });
  }
}

/** Mirrors `DunningBridgeOutcome`; restated so the label set stays closed. */
export type DunningBridgeMetricOutcome = 'applied' | 'not_tracked' | 'rejected' | 'skipped';
