import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BullMqSchedulerService } from '@taste-and-see/nest-bullmq-scheduler';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';
import { RbacRevokerMetrics } from './rbac-revoker-metrics';
import { RoleAssignmentExpiryService } from './role-assignment-expiry.service';

/**
 * Queue + repeatable-job identifiers. The acceptance's `workers/rbac-revoker`
 * naming is satisfied by the queue name — the worker itself lives INSIDE
 * service-identity (see the module doc on `RbacRevokerRunner`): the sweep
 * needs identity's Prisma client, and a standalone worker app would either
 * violate the cross-service DB prohibition (CLAUDE.md §2.3) or need an
 * internal bulk-revoke API for no other caller.
 *
 * The scheduler id differs from the queue name and is passed EXPLICITLY to
 * `schedule(...)` (which would otherwise default it to the queue name):
 * `rbac-revoker-sweep` is already live in every deployed Redis, and
 * renaming it would leave the old repeatable definition behind — the sweep
 * would then run twice per interval until someone pruned it by hand.
 */
export const RBAC_REVOKER_QUEUE_NAME = 'rbac-revoker';
export const RBAC_REVOKER_SCHEDULER_ID = 'rbac-revoker-sweep';

/**
 * The rbac-revoker's scheduling half (TS-293).
 *
 * The BullMQ queue + worker lifecycle, the Redis connection decomposition,
 * the CLAUDE.md §3.7 key prefix and the shutdown drain all live in
 * `@taste-and-see/nest-bullmq-scheduler` (TS-308a-followup-1) — this class
 * keeps only what is identity's: the kill switch, the cadence, the batch
 * size, and the sweep body.
 *
 * Disabled via `RBAC_REVOKER_ENABLED=false` (one-off Jobs, Redis-less
 * environments), which creates no queue at all. Observability per
 * CLAUDE.md §10: the shared scheduler logs the arm and any BullMQ-level
 * job failure; this class logs + records metrics on the sweep itself —
 * info on success, error on a throw (which BullMQ marks failed and the
 * next tick retries).
 *
 * The tick runs inside `runWithoutTenantContext`. A scheduled sweep has no
 * request and therefore no `RequestContext`, and identity's Prisma gate is
 * in `enforce` mode — so without the exempt frame `expireSweep`'s
 * `userRole.findMany` is a hard `MissingRequestContextError` (CLAUDE.md
 * §3.2). The wrap sits here rather than inside the expiry service because
 * "this whole tick is system work" is a property of the schedule, not of
 * the query; a future request-driven caller of `expireSweep` should carry
 * its own scope.
 */
@Injectable()
export class RbacRevokerRunner implements OnModuleInit {
  private readonly logger = new Logger(RbacRevokerRunner.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(BullMqSchedulerService) private readonly scheduler: BullMqSchedulerService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
    private readonly expiry: RoleAssignmentExpiryService,
    private readonly metrics: RbacRevokerMetrics,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduler.schedule({
      queueName: RBAC_REVOKER_QUEUE_NAME,
      schedulerId: RBAC_REVOKER_SCHEDULER_ID,
      intervalMs: this.env.RBAC_REVOKER_INTERVAL_MS,
      enabled: this.env.RBAC_REVOKER_ENABLED,
      disabledBy: 'RBAC_REVOKER_ENABLED',
      processor: () => this.runSweep(),
      details: { batchSize: this.env.RBAC_REVOKER_BATCH_SIZE },
    });
  }

  /** One tick: drain expired assignments, record outcome. */
  async runSweep(): Promise<void> {
    const startedAtMs = Date.now();
    try {
      const result = await runWithoutTenantContext(this.tenantStore, 'rbac-revoker-sweep', () =>
        this.expiry.expireSweep({
          batchSize: this.env.RBAC_REVOKER_BATCH_SIZE,
        }),
      );
      this.metrics.recordSweep('ok', result.revokedCount, (Date.now() - startedAtMs) / 1_000);
      this.logger.log(
        { revokedCount: result.revokedCount, batchCount: result.batchCount },
        'rbac-revoker sweep completed',
      );
    } catch (err) {
      this.metrics.recordSweep('error', 0, (Date.now() - startedAtMs) / 1_000);
      this.logger.error(
        { error: (err as Error).message ?? String(err) },
        'rbac-revoker sweep failed',
      );
      throw err;
    }
  }
}
