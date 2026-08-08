import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BullMqSchedulerService } from '@taste-and-see/nest-bullmq-scheduler';
import { type Counter, getMeter, type Histogram } from '@taste-and-see/tracing';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { VerificationTokenPruneService } from './services/verification-token-prune.service';

export const VERIFICATION_TOKEN_PRUNE_QUEUE_NAME = 'verification-token-prune';

/**
 * Scheduling half of the email-verification-token prune
 * (TS-510-followup-1). The fifth consumer of
 * `@taste-and-see/nest-bullmq-scheduler`.
 *
 * **`runWithoutTenantContext` is mandatory, not decorative.** A scheduled
 * sweep has no request and therefore no `RequestContext`, and identity's
 * Prisma gate runs in `enforce` mode — an unwrapped query is a hard
 * `MissingRequestContextError` (CLAUDE.md §3.2). TS-308a-followup-1 found
 * the rbac-revoker tick failing on exactly this.
 *
 * **A metric is emitted on every run, including a run that deleted
 * nothing.** An absent series and a zero series mean opposite things: one
 * says the sweep is not running, the other says it is running and there
 * is nothing to do. Only the second is fine, and a counter that only
 * appears when work happens cannot tell them apart.
 *
 * The summary logs at INFO whatever the count — unlike the privacy
 * overdue sweep, a large number here is housekeeping catching up, not bad
 * news. `truncated` is the field worth watching: a run that is *always*
 * truncated means the batch cap is below the accrual rate and the table
 * is still growing.
 */
@Injectable()
export class VerificationTokenPruneRunner implements OnModuleInit {
  private readonly logger = new Logger(VerificationTokenPruneRunner.name);
  private readonly runCounter: Counter;
  private readonly deletedCounter: Counter;
  private readonly durationHistogram: Histogram;

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(BullMqSchedulerService) private readonly scheduler: BullMqSchedulerService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
    private readonly pruneService: VerificationTokenPruneService,
  ) {
    const meter = getMeter('service-identity:verification-token-prune');
    this.runCounter = meter.createCounter('verification_token_prune_runs_total', {
      description:
        'Email-verification-token prune runs, by outcome (ok / error) and whether the batch cap was hit.',
    });
    this.deletedCounter = meter.createCounter('verification_token_prune_deleted_total', {
      description: 'Email-verification-token rows deleted by the prune sweep.',
    });
    this.durationHistogram = meter.createHistogram('verification_token_prune_duration_seconds', {
      description: 'Duration of one email-verification-token prune tick, in seconds.',
      unit: 's',
    });
  }

  async onModuleInit(): Promise<void> {
    await this.scheduler.schedule({
      queueName: VERIFICATION_TOKEN_PRUNE_QUEUE_NAME,
      intervalMs: this.env.VERIFICATION_TOKEN_PRUNE_INTERVAL_MS,
      enabled: this.env.VERIFICATION_TOKEN_PRUNE_ENABLED,
      disabledBy: 'VERIFICATION_TOKEN_PRUNE_ENABLED',
      processor: () => this.runSweep(),
      details: {
        retentionDays: this.env.VERIFICATION_TOKEN_PRUNE_RETENTION_DAYS,
        batchSize: this.env.VERIFICATION_TOKEN_PRUNE_BATCH_SIZE,
      },
    });
  }

  async runSweep(now: Date = new Date()): Promise<void> {
    const startedAtMs = Date.now();
    try {
      const result = await runWithoutTenantContext(
        this.tenantStore,
        'verification-token-prune-sweep',
        () =>
          this.pruneService.prune({
            now,
            retentionDays: this.env.VERIFICATION_TOKEN_PRUNE_RETENTION_DAYS,
            batchSize: this.env.VERIFICATION_TOKEN_PRUNE_BATCH_SIZE,
          }),
      );

      this.runCounter.add(1, { outcome: 'ok', truncated: String(result.truncated) });
      this.deletedCounter.add(result.deletedCount);
      this.durationHistogram.record((Date.now() - startedAtMs) / 1_000);

      this.logger.log(
        {
          deletedCount: result.deletedCount,
          truncated: result.truncated,
          retentionDays: this.env.VERIFICATION_TOKEN_PRUNE_RETENTION_DAYS,
        },
        'verification-token prune completed',
      );
    } catch (err) {
      this.runCounter.add(1, { outcome: 'error', truncated: 'false' });
      this.durationHistogram.record((Date.now() - startedAtMs) / 1_000);
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'verification-token prune failed',
      );
      // Rethrown so BullMQ marks the job failed and it is visible in the
      // queue rather than only in a log line nobody is watching.
      throw err;
    }
  }
}
