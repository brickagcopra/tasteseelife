import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

import type { DunningDispatchOutcome } from './dunning-ladder.service';

const METER_NAME = 'service-notification:dunning';

/**
 * The dunning ladder's instrument (TS-042-followup-3a2b).
 *
 * `notification_dunning_dispatches_total{outcome,template_code}` answers the
 * one question the ladder exists for: **did the family actually get told?**
 *
 * TS-042-followup-3a2 shipped with logs only. The outcome union was already
 * built as a closed set of named kinds precisely so it could be a label, and
 * the two that matter most are the two a log-only build buries:
 *
 *   - `no_payer` — a household in dunning with no active `primary_payer`.
 *     Nobody is mailed, nothing is broken, and the family's care lapses on
 *     schedule with no warning. Somebody has to notice, and a log line in a
 *     mailer nobody watches is not noticing.
 *   - `no_deliverable_contact` — every payer's account is suspended or
 *     deactivated. Same silence, different cause, and the cause changes the
 *     fix (add a payer vs restore an account), so they are separate labels
 *     rather than one "unreachable".
 *
 * `skipped_customer_group` is the third: a steady non-zero rate is provider
 * subscriptions entering dunning with no resolver behind them
 * (TS-042-followup-3a1a), which is a real customer population going untold.
 *
 * `skipped_rung` should DOMINATE in steady state — it is every routine
 * renewal. A `skipped_rung` of zero while subscriptions are renewing means
 * the `payment_succeeded` handler is not running at all.
 *
 * **Cardinality.** Five outcome literals × four template codes, and the two
 * are correlated (every skip carries `none`), so the real series count is
 * ~9. `template_code` earns its place because "we sent something" and "we
 * sent the SUSPENDED email" are different operational facts and the second
 * is the one that should have a threshold on it.
 *
 * **No recipient, no household id, no subscription id, no address** — this
 * is a telemetry channel, and who is behind on payment for whose care is not
 * a label (CLAUDE.md §3.9, §12).
 */
@Injectable()
export class DunningMetrics {
  private readonly dispatches: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.dispatches = meter.createCounter('notification_dunning_dispatches_total', {
      description:
        'Total dunning-ladder events handled, by outcome and template code. Counts every path including the skips — a ladder that mails nobody must not look like a ladder with nothing to report.',
    });
  }

  /**
   * Record one handled event.
   *
   * `recipientCount` is deliberately NOT a label (unbounded-ish and better
   * as a separate instrument if ever needed) and NOT the increment: this
   * counts EVENTS handled, so a two-payer household and a one-payer
   * household each add one. Counting recipients here would make "how many
   * dunning events did we handle" unanswerable.
   */
  record(outcome: DunningDispatchOutcome, templateCode: string | null): void {
    this.dispatches.add(1, {
      outcome: outcome.kind,
      // A literal `none`, not an absent label — an absent label makes the
      // skip series a different shape from the send series, and PromQL joins
      // across the two stop working.
      template_code: templateCode ?? 'none',
    });
  }
}
