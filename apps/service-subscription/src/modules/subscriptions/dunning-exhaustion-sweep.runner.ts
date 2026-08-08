import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { BullMqSchedulerService } from '@taste-and-see/nest-bullmq-scheduler';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { DunningExhaustionSweepService } from './services/dunning-exhaustion-sweep.service';

export const DUNNING_EXHAUSTION_QUEUE_NAME = 'subscription-dunning-exhaustion';
export const DUNNING_EXHAUSTION_SCHEDULER_ID = 'subscription-dunning-exhaustion';

/**
 * Scheduling half of the dunning-exhaustion sweep (TS-042-followup-2;
 * PDD §11.4; CLAUDE.md §4.3).
 *
 * Fourth consumer of `@taste-and-see/nest-bullmq-scheduler`, which owns the
 * queue and worker lifecycle, the Redis decomposition, the CLAUDE.md §3.7 key
 * prefix and the shutdown drain. The sweep runs INSIDE service-subscription
 * rather than in a standalone worker app for the TS-293 reason: it needs this
 * service's own Prisma client and its `DunningService`, and a worker app would
 * either breach CLAUDE.md §2.3 or need an internal bulk-transition API with no
 * other caller.
 *
 * **The tick runs inside `runWithoutTenantContext`, and skipping that is a
 * defect that only shows up in production.** A scheduled job has no
 * `RequestContext` for the tenant-scoping interceptor to seed, and this
 * service runs the gate in `enforce` mode — so an unwrapped tick dies with
 * `MissingRequestContextError` on its first typed Prisma call, on a path no
 * unit test exercises because no unit test has a real Redis to fire the timer.
 * That is exactly how TS-308a-followup-1 found identity's rbac-revoker had
 * been broken on every tick it never ran. Exhausting a grace window is system
 * work by nature: the sweep asks a question about every tenant at once, which
 * is a property of the schedule, not of any one query.
 *
 * **`SUBSCRIPTION_DUNNING_SWEEP_ENABLED=false` creates no queue and no worker
 * at all.** A real operational need rather than a test affordance — if the
 * sweep starts converting subscriptions it should not, ops turns it off with
 * an env change rather than a redeploy. The scheduler logs the disabling env
 * var by name, because "not running" is only actionable if the operator knows
 * which lever.
 */
@Injectable()
export class DunningExhaustionSweepRunner implements OnModuleInit {
  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(BullMqSchedulerService) private readonly scheduler: BullMqSchedulerService,
    private readonly sweep: DunningExhaustionSweepService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduler.schedule({
      queueName: DUNNING_EXHAUSTION_QUEUE_NAME,
      // Passed EXPLICITLY even though it equals the queue name: a live
      // repeatable definition left orphaned by a rename ticks forever
      // alongside its replacement.
      schedulerId: DUNNING_EXHAUSTION_SCHEDULER_ID,
      intervalMs: this.env.SUBSCRIPTION_DUNNING_SWEEP_INTERVAL_MS,
      enabled: this.env.SUBSCRIPTION_DUNNING_SWEEP_ENABLED,
      disabledBy: 'SUBSCRIPTION_DUNNING_SWEEP_ENABLED',
      processor: () => this.runTick(),
      details: { intervalMs: this.env.SUBSCRIPTION_DUNNING_SWEEP_INTERVAL_MS },
    });
  }

  async runTick(now: Date = new Date()): Promise<void> {
    await runWithoutTenantContext(this.tenantStore, 'dunning-exhaustion-sweep', () =>
      this.sweep.sweep({ now }),
    );
  }
}
