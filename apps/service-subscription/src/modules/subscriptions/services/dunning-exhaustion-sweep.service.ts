import { Injectable, Logger } from '@nestjs/common';

import { SubscriptionMetrics } from '../../../observability/subscription-metrics';
import { PrismaService } from '../../../prisma/prisma.service';
import { DunningService } from './dunning.service';

/**
 * Hard cap on subscriptions exhausted in one tick.
 *
 * Each one is a transaction plus a `subscription_history` insert, and the
 * whole point of a grace window is that expiries trickle. A backlog large
 * enough to hit this cap means something else went wrong — the sweep was off
 * for days, or a billing incident pushed a whole cohort past due at once — and
 * in that situation converting the entire cohort in a single tick is the wrong
 * response. The cap is REPORTED (`truncated`), never silent (CLAUDE.md §10):
 * the next tick takes the next batch, so nothing is lost, but an operator can
 * see the backlog.
 */
const MAX_PER_TICK = 200;

export interface DunningExhaustionSweepResult {
  readonly candidates: number;
  readonly exhausted: number;
  readonly skipped: number;
  readonly failed: number;
  readonly truncated: boolean;
}

/**
 * Converts `past_due` subscriptions whose grace window has expired into
 * `unpaid` (TS-042-followup-2; PRD §10.3; PDD §11.4; CLAUDE.md §4.3, §6).
 *
 * **Without this, `dunningGraceUntil` is a deadline nothing enforces.**
 * TS-042 built `applyDunningExhaustion` and TS-042-followup-4 wired the
 * failures that stamp the deadline, but nothing ever came back to check
 * whether it had passed — so a subscription could sit `past_due` with an
 * expired grace window indefinitely, which reads to every dashboard and every
 * downstream consumer as "still in the retry window" long after the retries
 * ended.
 *
 * **The sweep FINDS; `DunningService` DECIDES.** This service does one
 * projection query and then calls `applyDunningExhaustion` per row — it does
 * not re-derive the expiry rule, write a status, or touch a history row. The
 * transition's preconditions (`status === 'past_due'`, a non-null
 * `dunningGraceUntil`, the grace actually expired) are re-checked inside that
 * call against the row as it is at that moment, which is what makes a stale
 * candidate list safe: a subscription that recovered between the query and the
 * call is rejected by the service, not converted by the sweep.
 *
 * **A per-row failure never stops the tick.** Each subscription is
 * independent; letting one locked row cost every other family's transition —
 * with nothing saying the rest were skipped rather than clean — is the quiet
 * failure this whole area exists to avoid. Failures are counted, logged, and
 * left for the next tick.
 */
@Injectable()
export class DunningExhaustionSweepService {
  private readonly logger = new Logger(DunningExhaustionSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dunning: DunningService,
    private readonly metrics: SubscriptionMetrics,
  ) {}

  async sweep(args: { readonly now?: Date } = {}): Promise<DunningExhaustionSweepResult> {
    const now = args.now ?? new Date();

    // Served by the TS-042-followup-1 PARTIAL index
    // `(dunning_grace_until) WHERE status='past_due' AND dunning_grace_until IS NOT NULL`,
    // which was built for this query and has had no reader until now.
    //
    // EXPLAIN: Index Scan using subscriptions_dunning_grace_idx, over a
    // relation that stays proportional to the number of subscriptions
    // currently in dunning rather than to the table.
    const candidates = await this.prisma.subscription.findMany({
      where: { status: 'past_due', dunningGraceUntil: { lt: now } },
      // Oldest deadline first: the family who has been waiting longest gets
      // resolved first if the cap bites.
      orderBy: { dunningGraceUntil: 'asc' },
      take: MAX_PER_TICK + 1,
      select: { id: true },
    });

    const truncated = candidates.length > MAX_PER_TICK;
    const batch = truncated ? candidates.slice(0, MAX_PER_TICK) : candidates;

    let exhausted = 0;
    let skipped = 0;
    let failed = 0;

    for (const candidate of batch) {
      try {
        const result = await this.dunning.applyDunningExhaustion({
          subscriptionId: candidate.id,
          // Deterministic per subscription per tick-day, so a retried tick
          // produces a traceable `subscription_history.source` rather than a
          // fresh opaque id each time.
          sourceEventId: `dunning-exhaustion-sweep:${candidate.id}:${now
            .toISOString()
            .slice(0, 10)}`,
          now,
        });

        if (result.ok) {
          exhausted += 1;
        } else {
          // Not an error. The row moved between the query and the call — it
          // recovered, or another tick got there first — and the service
          // refusing is exactly the guard that makes a stale candidate list
          // safe.
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        this.logger.error(
          `dunning.exhaustion_sweep.row_failed ${JSON.stringify({
            subscriptionId: candidate.id,
            error: error instanceof Error ? error.message : 'unknown',
          })}`,
        );
      }
    }

    const result: DunningExhaustionSweepResult = {
      candidates: batch.length,
      exhausted,
      skipped,
      failed,
      truncated,
    };

    this.metrics.recordDunningExhaustionSweep(result);

    // Logged on EVERY tick including a clean one. A sweep you only hear about
    // when it finds something is indistinguishable from a sweep that stopped
    // running (TS-306-followup-1a's posture).
    const summary = JSON.stringify(result);
    if (failed > 0 || truncated) {
      this.logger.warn(`dunning.exhaustion_sweep.completed ${summary}`);
    } else {
      this.logger.log(`dunning.exhaustion_sweep.completed ${summary}`);
    }

    return result;
  }
}

export { MAX_PER_TICK as DUNNING_EXHAUSTION_MAX_PER_TICK };
