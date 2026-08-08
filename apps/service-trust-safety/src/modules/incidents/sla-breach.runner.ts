import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BullMqSchedulerService } from '@taste-and-see/nest-bullmq-scheduler';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { SlaBreachMetrics } from './services/sla-breach-metrics';
import { SLA_DUE_SOON_MINUTES, SlaBreachSweepService } from './services/sla-breach-sweep.service';

export const SLA_BREACH_QUEUE_NAME = 'trust-safety-sla-sweep';

/**
 * Scheduling half of the SLA-breach sweep (TS-306-followup-1a).
 *
 * **service-trust-safety's first BullMQ queue**, and it cost almost
 * nothing: TS-308a-followup-1 extracted the runner shape into
 * `@taste-and-see/nest-bullmq-scheduler` after its third copy, so what
 * is left here is what trust & safety decides — the cadence, the kill
 * switch, and what a breach should say.
 *
 * **It does not page, and that is the whole reason this half could
 * ship.** TS-306 pages the moment a `critical` incident arrives; paging
 * again on BREACH is TS-306-followup-1b and stays blocked on
 * TS-300-followup-3, because `SLA_BUDGET_MINUTES` are placeholder
 * engineering defaults nobody with standing has confirmed. A page
 * against a made-up deadline is worse than no page: it is the fastest
 * way to teach a responder that these pages can be ignored, and that
 * lesson would carry over to the intake pages that ARE meaningful. A
 * WARN costs nothing if the number turns out to be wrong, and it is what
 * ops can act on today.
 *
 * **The metric arrived with TS-306-followup-1c.** This runner shipped
 * with none: CLAUDE.md §10 asks every worker for one, and this sweep is
 * exactly the kind that wants a gauge, but `service-trust-safety` had no
 * observability wiring at all — no `@taste-and-see/tracing` dependency,
 * no `ObservabilityModule`, no `initMetrics` in `main.ts`. A meter then
 * would have been a permanent no-op that reads as instrumentation while
 * reporting nothing, which is worse than the honest gap, so the metrics
 * class written for this sweep was deleted rather than shipped. It now
 * exists (`SlaBreachMetrics`) on a meter provider that is really wired.
 * The `breachedCount` it records is the UNCAPPED count, never
 * `rows.length` — the separate-queries design exists so a truncated log
 * cannot make the alerting series under-report.
 *
 * The tick runs inside `runWithoutTenantContext`: a scheduled sweep has
 * no request and therefore no `RequestContext`, and this service's
 * Prisma gate is in enforce mode, so an unwrapped query never runs at
 * all (CLAUDE.md §3.2).
 */
@Injectable()
export class SlaBreachRunner implements OnModuleInit {
  private readonly logger = new Logger(SlaBreachRunner.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(BullMqSchedulerService) private readonly scheduler: BullMqSchedulerService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
    private readonly sweepService: SlaBreachSweepService,
    private readonly metrics: SlaBreachMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduler.schedule({
      queueName: SLA_BREACH_QUEUE_NAME,
      intervalMs: this.env.TRUST_SAFETY_SLA_SWEEP_INTERVAL_MS,
      enabled: this.env.TRUST_SAFETY_SLA_SWEEP_ENABLED,
      disabledBy: 'TRUST_SAFETY_SLA_SWEEP_ENABLED',
      processor: () => this.runSweep(),
      details: {
        dueSoonMinutes: SLA_DUE_SOON_MINUTES,
        maxLogged: this.env.TRUST_SAFETY_SLA_SWEEP_MAX_LOGGED,
      },
    });
  }

  /**
   * One tick: count, enumerate, report.
   *
   * The summary logs at INFO when nothing is breached and WARN when
   * something is — an always-INFO summary would make "an unresolved
   * welfare concern has been sitting past its deadline" indistinguishable
   * from a heartbeat. Per-incident lines carry the measurement AND the
   * budget in force beside it, the TS-308c-followup-2 console rule: a
   * number without its threshold reads as a verdict.
   */
  async runSweep(now: Date = new Date()): Promise<void> {
    const startedAtMs = Date.now();
    try {
      const result = await runWithoutTenantContext(
        this.tenantStore,
        'trust-safety-sla-breach-sweep',
        () =>
          this.sweepService.sweep({
            now,
            maxLogged: this.env.TRUST_SAFETY_SLA_SWEEP_MAX_LOGGED,
          }),
      );

      for (const row of result.rows) {
        this.logger.warn(
          `trust_safety.sla.breached ${JSON.stringify({
            incidentId: row.id,
            severity: row.severity,
            category: row.category,
            status: row.status,
            minutesOverdue: row.minutesOverdue,
            budgetMinutes: row.budgetMinutes,
          })}`,
        );
      }

      // Recorded on every tick INCLUDING the clean one: an absent series
      // and a zero series mean opposite things here — "nothing is late"
      // versus "nobody is checking" (TS-306-followup-1c).
      this.metrics.recordSweep(
        'ok',
        { breachedCount: result.breachedCount, dueSoonCount: result.dueSoonCount },
        (Date.now() - startedAtMs) / 1_000,
      );

      const summary = {
        breachedCount: result.breachedCount,
        dueSoonCount: result.dueSoonCount,
        loggedCount: result.rows.length,
        truncated: result.truncated,
        dueSoonMinutes: SLA_DUE_SOON_MINUTES,
      };
      if (result.breachedCount > 0) {
        this.logger.warn(
          `trust_safety.sla.sweep_completed_with_breaches ${JSON.stringify(summary)}`,
        );
      } else {
        this.logger.log(`trust_safety.sla.sweep_completed ${JSON.stringify(summary)}`);
      }
    } catch (err) {
      // Counts are not recorded on the error path — there are none, and a
      // zero here would be indistinguishable from a clean sweep on the very
      // series ops alerts against.
      this.metrics.recordSweep(
        'error',
        { breachedCount: 0, dueSoonCount: 0 },
        (Date.now() - startedAtMs) / 1_000,
      );
      this.logger.error(
        `trust_safety.sla.sweep_failed ${JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        })}`,
      );
      throw err;
    }
  }
}
