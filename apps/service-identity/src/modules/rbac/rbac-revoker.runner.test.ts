import type {
  BullMqSchedulerService,
  ScheduledSweepSpec,
} from '@taste-and-see/nest-bullmq-scheduler';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import type { RbacRevokerMetrics } from './rbac-revoker-metrics';
import {
  RBAC_REVOKER_QUEUE_NAME,
  RBAC_REVOKER_SCHEDULER_ID,
  RbacRevokerRunner,
} from './rbac-revoker.runner';
import type { RoleAssignmentExpiryService } from './role-assignment-expiry.service';

/**
 * Unit tests for the TS-293 rbac-revoker.
 *
 * Since TS-308a-followup-1 the queue lifecycle lives in
 * `@taste-and-see/nest-bullmq-scheduler`, so the scheduler is faked and
 * what is asserted here is what identity actually decides: the cadence,
 * the kill switch, the preserved scheduler id, and the sweep body. The
 * prefix derivation, the shutdown drain and the BullMQ failure hook are
 * the package's tests now.
 */

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379/0',
    RBAC_REVOKER_ENABLED: true,
    RBAC_REVOKER_INTERVAL_MS: 300_000,
    RBAC_REVOKER_BATCH_SIZE: 500,
    IMPERSONATION_SESSION_TTL_SECONDS: 3_600,
    ...overrides,
  } as Env;
}

function buildFakes(sweep?: () => Promise<{ revokedCount: number; batchCount: number }>): {
  scheduler: BullMqSchedulerService;
  specs: ScheduledSweepSpec[];
  store: TenantContextStore;
  frames: Array<{ kind: string; reason?: string } | null>;
  expiry: RoleAssignmentExpiryService;
  expireSweep: ReturnType<typeof vi.fn>;
  metrics: RbacRevokerMetrics;
  recordSweep: ReturnType<typeof vi.fn>;
} {
  const specs: ScheduledSweepSpec[] = [];
  const scheduler = {
    schedule: async (spec: ScheduledSweepSpec) => {
      specs.push(spec);
    },
  } as unknown as BullMqSchedulerService;
  const store = new TenantContextStore();
  const frames: Array<{ kind: string; reason?: string } | null> = [];
  const expireSweep = vi.fn(async () => {
    // Capture the frame the gate would see at the moment the sweep runs.
    frames.push(store.current() as { kind: string; reason?: string } | null);
    return sweep !== undefined ? sweep() : { revokedCount: 0, batchCount: 0 };
  });
  const expiry = { expireSweep } as unknown as RoleAssignmentExpiryService;
  const recordSweep = vi.fn();
  const metrics = { recordSweep } as unknown as RbacRevokerMetrics;
  return { scheduler, specs, store, frames, expiry, expireSweep, metrics, recordSweep };
}

describe('RbacRevokerRunner', () => {
  it('exposes the acceptance-named queue + scheduler ids', () => {
    expect(RBAC_REVOKER_QUEUE_NAME).toBe('rbac-revoker');
    expect(RBAC_REVOKER_SCHEDULER_ID).toBe('rbac-revoker-sweep');
  });

  it('registers the sweep at the configured interval', async () => {
    const fakes = buildFakes();
    const runner = new RbacRevokerRunner(
      buildEnv(),
      fakes.scheduler,
      fakes.store,
      fakes.expiry,
      fakes.metrics,
    );

    await runner.onModuleInit();

    expect(fakes.specs).toHaveLength(1);
    expect(fakes.specs[0]?.queueName).toBe('rbac-revoker');
    expect(fakes.specs[0]?.intervalMs).toBe(300_000);
  });

  it('passes the scheduler id EXPLICITLY — it predates the queue-name default', async () => {
    // `rbac-revoker-sweep` is already live in every deployed Redis. Letting
    // it default to the queue name would leave the old repeatable
    // definition behind and the sweep would run twice per interval.
    const fakes = buildFakes();
    const runner = new RbacRevokerRunner(
      buildEnv(),
      fakes.scheduler,
      fakes.store,
      fakes.expiry,
      fakes.metrics,
    );

    await runner.onModuleInit();

    expect(fakes.specs[0]?.schedulerId).toBe('rbac-revoker-sweep');
  });

  it('hands the kill switch through with the env var that controls it', async () => {
    const fakes = buildFakes();
    const runner = new RbacRevokerRunner(
      buildEnv({ RBAC_REVOKER_ENABLED: false }),
      fakes.scheduler,
      fakes.store,
      fakes.expiry,
      fakes.metrics,
    );

    await runner.onModuleInit();

    expect(fakes.specs[0]?.enabled).toBe(false);
    expect(fakes.specs[0]?.disabledBy).toBe('RBAC_REVOKER_ENABLED');
  });

  it('a tick runs the sweep with the configured batch size and records ok', async () => {
    const fakes = buildFakes(async () => ({ revokedCount: 7, batchCount: 2 }));
    const runner = new RbacRevokerRunner(
      buildEnv({ RBAC_REVOKER_BATCH_SIZE: 123 }),
      fakes.scheduler,
      fakes.store,
      fakes.expiry,
      fakes.metrics,
    );
    await runner.onModuleInit();

    await fakes.specs[0]?.processor();

    expect(fakes.expireSweep).toHaveBeenCalledWith({ batchSize: 123 });
    expect(fakes.recordSweep).toHaveBeenCalledTimes(1);
    expect(fakes.recordSweep.mock.calls[0]?.[0]).toBe('ok');
    expect(fakes.recordSweep.mock.calls[0]?.[1]).toBe(7);
  });

  it('a failing sweep records error and rethrows so BullMQ marks the job failed', async () => {
    const fakes = buildFakes(async () => {
      throw new Error('db down');
    });
    const runner = new RbacRevokerRunner(
      buildEnv(),
      fakes.scheduler,
      fakes.store,
      fakes.expiry,
      fakes.metrics,
    );
    await runner.onModuleInit();

    await expect(fakes.specs[0]?.processor()).rejects.toThrow('db down');
    expect(fakes.recordSweep.mock.calls[0]?.[0]).toBe('error');
  });

  it('runs the tick inside an EXEMPT tenant frame', async () => {
    // Identity's Prisma gate is in `enforce` mode and `expireSweep` reads
    // `userRole` through the typed API, so without this frame every tick
    // is a hard `MissingRequestContextError` — a sweep that silently never
    // drains. A scheduled job has no request and therefore no
    // RequestContext; the exempt frame is how it says so (CLAUDE.md §3.2).
    const fakes = buildFakes();
    const runner = new RbacRevokerRunner(
      buildEnv(),
      fakes.scheduler,
      fakes.store,
      fakes.expiry,
      fakes.metrics,
    );
    await runner.onModuleInit();

    await fakes.specs[0]?.processor();

    expect(fakes.frames).toEqual([{ kind: 'exempt', reason: 'rbac-revoker-sweep' }]);
  });

  it('echoes the batch size onto the arm-time log line', async () => {
    const fakes = buildFakes();
    const runner = new RbacRevokerRunner(
      buildEnv({ RBAC_REVOKER_BATCH_SIZE: 42 }),
      fakes.scheduler,
      fakes.store,
      fakes.expiry,
      fakes.metrics,
    );

    await runner.onModuleInit();

    expect(fakes.specs[0]?.details).toEqual({ batchSize: 42 });
  });
});
