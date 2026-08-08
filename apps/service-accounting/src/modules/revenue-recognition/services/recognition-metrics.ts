import { Injectable } from '@nestjs/common';
import { type Counter, getMeter } from '@taste-and-see/tracing';

import type { RecognitionPauseResult } from './subscription-revenue-recognizer.service';

const METER_NAME = 'service-accounting:revenue-recognition';

/** Which of the two suspension surfaces produced the outcome. */
export type RecognitionPauseOperation = 'pause' | 'resume';

/**
 * Instrument for the pause / resume suspension surfaces
 * (TS-042-followup-3b2-followup-2).
 *
 * `accounting_recognition_pause_total{operation,result}` answers the
 * question those two methods exist for: **is amortisation actually being
 * suspended and restarted, on the balances it should be?**
 *
 * TS-042-followup-3b2 shipped them with logs only, which is the same defect
 * TS-042-followup-3a2b fixed one service over. The result union was built as
 * a closed set of named kinds precisely so it could be a label.
 *
 * **`no_balance` is the label that justifies the instrument.** It is the
 * silent arm: a pause or resume arrives, there is no in-flight
 * deferred-revenue balance to act on, and the handler returns normally
 * because a fully-recognised subscription is legitimately pausable with
 * nothing to suspend. A steady non-zero rate means something else — either
 * `subscription.activated` is not landing (so nothing is being amortised at
 * all), or subscriptions are being paused whose revenue nobody is tracking.
 * Neither breaks anything, which is exactly why it needs a number.
 *
 * `idempotent_replay` should be RARE and near-flat: the SDK's dedup table
 * absorbs ordinary redeliveries before the recogniser is reached, so a rising
 * rate here means that table is not doing its job and the status guard is
 * carrying idempotency alone.
 *
 * **`resume` counts should track `pause` counts over time.** A persistent
 * gap is the TS-042-followup-3b2-followup-1 failure mode — balances suspended
 * and never restarted, revenue quietly stranded — and comparing the two
 * series is the cheapest way to see it. That is the second reason `operation`
 * is a label rather than two instruments.
 *
 * **Cardinality.** Two operations × three results = six series, fixed.
 *
 * **No subscription id, no customer id, no balance id, no amount** — this is
 * a telemetry channel, and which family paused their mother's care is not a
 * label (CLAUDE.md §3.9, §10, §12).
 */
@Injectable()
export class RecognitionMetrics {
  private readonly pauseTransitions: Counter;

  constructor() {
    const meter = getMeter(METER_NAME);
    this.pauseTransitions = meter.createCounter('accounting_recognition_pause_total', {
      description:
        'Total subscription pause / resume events applied to deferred-revenue balances, by operation and result. Counts every path including the no-ops — a surface that acts on nothing must not look like a surface with nothing to do.',
    });
  }

  /**
   * Record one handled pause or resume.
   *
   * The number of balances affected is deliberately NOT a label: it is
   * unbounded-ish and the interesting fact is already in `result`
   * (`no_balance` vs anything else). It stays in the log line beside the
   * balance ids.
   */
  record(operation: RecognitionPauseOperation, result: RecognitionPauseResult): void {
    this.pauseTransitions.add(1, { operation, result });
  }
}
