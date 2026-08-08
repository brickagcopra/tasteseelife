import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BullMqSchedulerService } from '@taste-and-see/nest-bullmq-scheduler';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { PrivacyOverdueMetrics } from './services/privacy-overdue-metrics';
import { PrivacyOverdueSweepService } from './services/privacy-overdue-sweep.service';

export const PRIVACY_OVERDUE_QUEUE_NAME = 'privacy-overdue-sweep';

/**
 * Scheduling half of the overdue data-subject-request sweep
 * (TS-309a-followup-2).
 *
 * **This is the third consumer of the in-service BullMQ runner shape, and
 * it is why that shape is now a package.** TS-293's rbac-revoker and
 * TS-308a's anomaly sweep had it verbatim; rather than write it a third
 * time, TS-308a-followup-1 extracted
 * `@taste-and-see/nest-bullmq-scheduler`, and this runner was built
 * against it. What is left here is what privacy decides: the cadence, the
 * kill switch, the lead-time window, and what a late request should say.
 *
 * **It deliberately does NOT page.** A missed privacy deadline is a
 * compliance failure to escalate in working hours, not a 3am incident —
 * the contrast with TS-306, which pages on `critical` trust & safety
 * incidents, is the whole point. The signal is a metric plus a WARN line;
 * an operator picks it up from the dashboard and the queue.
 *
 * **It changes no rows.** See `PrivacyOverdueSweepService` for why
 * "overdue" must stay a function of the clock rather than a stored status.
 *
 * **Wording.** A breach is reported against "the configured response
 * window", never as unlawful: `DATA_SUBJECT_REQUEST_RESPONSE_DAYS` ships
 * as an UNCONFIRMED constant (TS-309a), and which deadline actually binds
 * a given request is legal reference data this codebase does not author.
 *
 * The whole tick runs inside `runWithoutTenantContext` — a scheduled sweep
 * has no request and therefore no `RequestContext`, and identity's Prisma
 * gate is in `enforce` mode, so an unwrapped query is a hard
 * `MissingRequestContextError` (CLAUDE.md §3.2).
 */
@Injectable()
export class PrivacyOverdueRunner implements OnModuleInit {
  private readonly logger = new Logger(PrivacyOverdueRunner.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(BullMqSchedulerService) private readonly scheduler: BullMqSchedulerService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
    private readonly sweepService: PrivacyOverdueSweepService,
    private readonly metrics: PrivacyOverdueMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduler.schedule({
      queueName: PRIVACY_OVERDUE_QUEUE_NAME,
      intervalMs: this.env.PRIVACY_OVERDUE_SWEEP_INTERVAL_MS,
      enabled: this.env.PRIVACY_OVERDUE_SWEEP_ENABLED,
      disabledBy: 'PRIVACY_OVERDUE_SWEEP_ENABLED',
      processor: () => this.runSweep(),
      details: {
        dueSoonDays: this.env.PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS,
        maxLogged: this.env.PRIVACY_OVERDUE_SWEEP_MAX_LOGGED,
      },
    });
  }

  /**
   * One tick: count, enumerate, report.
   *
   * The summary line is emitted at INFO when nothing is late and WARN when
   * something is — an always-INFO summary would make "we are behind on a
   * statutory request" indistinguishable from a heartbeat. Metrics are
   * recorded on both paths, including the zero: an absent series and a
   * clean series mean opposite things here, and only one of them is fine.
   */
  async runSweep(now: Date = new Date()): Promise<void> {
    const startedAtMs = Date.now();
    try {
      const result = await runWithoutTenantContext(this.tenantStore, 'privacy-overdue-sweep', () =>
        this.sweepService.sweep({
          now,
          dueSoonDays: this.env.PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS,
          maxLogged: this.env.PRIVACY_OVERDUE_SWEEP_MAX_LOGGED,
        }),
      );

      this.metrics.recordSweep(
        'ok',
        { overdueCount: result.overdueCount, dueSoonCount: result.dueSoonCount },
        (Date.now() - startedAtMs) / 1_000,
      );

      for (const row of result.rows) {
        this.logger.warn(
          {
            requestId: row.id,
            kind: row.kind,
            status: row.status,
            subjectKind: row.subjectKind,
            selfService: row.selfService,
            daysOverdue: row.daysOverdue,
            extensionTaken: row.extended,
          },
          'data-subject request is past the response window we have configured',
        );
      }

      const summary = {
        overdueCount: result.overdueCount,
        dueSoonCount: result.dueSoonCount,
        loggedCount: result.rows.length,
        truncated: result.truncated,
        responseWindowDays: this.env.PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS,
      };
      if (result.overdueCount > 0) {
        this.logger.warn(summary, 'privacy overdue sweep completed with requests past the window');
      } else {
        this.logger.log(summary, 'privacy overdue sweep completed');
      }
    } catch (err) {
      this.metrics.recordSweep(
        'error',
        { overdueCount: 0, dueSoonCount: 0 },
        (Date.now() - startedAtMs) / 1_000,
      );
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'privacy overdue sweep failed',
      );
      throw err;
    }
  }
}
