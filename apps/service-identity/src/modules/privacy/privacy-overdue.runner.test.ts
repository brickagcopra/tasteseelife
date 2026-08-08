import 'reflect-metadata';

import type {
  BullMqSchedulerService,
  ScheduledSweepSpec,
} from '@taste-and-see/nest-bullmq-scheduler';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import { PRIVACY_OVERDUE_QUEUE_NAME, PrivacyOverdueRunner } from './privacy-overdue.runner';
import type { PrivacyOverdueMetrics } from './services/privacy-overdue-metrics';
import type {
  OverdueSweepResult,
  PrivacyOverdueSweepService,
} from './services/privacy-overdue-sweep.service';

/**
 * Unit tests for the overdue-DSAR runner (TS-309a-followup-2).
 *
 * Constructed directly — vitest/esbuild emits no `design:paramtypes`, so
 * bare-param-type injection resolves to `undefined` under this runner.
 *
 * What is asserted here is what privacy decides, the queue lifecycle now
 * being the shared scheduler's (TS-308a-followup-1):
 *   - the tick runs inside an EXEMPT tenant frame — identity's gate is in
 *     `enforce` mode, so an unwrapped scheduled query never runs at all;
 *   - the metric is recorded on EVERY tick including a clean one (an
 *     absent series and a clean series mean opposite things here);
 *   - it never pages and never writes;
 *   - a clean sweep does not warn, and a late one does.
 */

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379/0',
    PRIVACY_OVERDUE_SWEEP_ENABLED: true,
    PRIVACY_OVERDUE_SWEEP_INTERVAL_MS: 3_600_000,
    PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS: 7,
    PRIVACY_OVERDUE_SWEEP_MAX_LOGGED: 25,
    ...overrides,
  } as unknown as Env;
}

const CLEAN: OverdueSweepResult = {
  overdueCount: 0,
  dueSoonCount: 0,
  rows: [],
  truncated: false,
};

const LATE: OverdueSweepResult = {
  overdueCount: 2,
  dueSoonCount: 5,
  truncated: false,
  rows: [
    {
      id: 'dsr_1',
      kind: 'access',
      status: 'in_progress',
      subjectKind: 'senior',
      selfService: false,
      dueAt: new Date('2026-07-20T00:00:00.000Z'),
      daysOverdue: 7,
      extended: true,
    },
  ],
};

interface Harness {
  readonly runner: PrivacyOverdueRunner;
  readonly specs: ScheduledSweepSpec[];
  readonly frames: Array<{ kind: string; reason?: string } | null>;
  readonly sweepArgs: Array<{ dueSoonDays: number; maxLogged: number; now: Date }>;
  readonly recordSweep: ReturnType<typeof vi.fn>;
}

function makeHarness(
  options: {
    readonly env?: Partial<Env>;
    readonly result?: OverdueSweepResult;
    readonly throws?: boolean;
  } = {},
): Harness {
  const specs: ScheduledSweepSpec[] = [];
  const frames: Array<{ kind: string; reason?: string } | null> = [];
  const sweepArgs: Array<{ dueSoonDays: number; maxLogged: number; now: Date }> = [];
  const store = new TenantContextStore();

  const scheduler = {
    schedule: async (spec: ScheduledSweepSpec) => {
      specs.push(spec);
    },
  } as unknown as BullMqSchedulerService;

  const sweepService = {
    sweep: async (args: { dueSoonDays: number; maxLogged: number; now: Date }) => {
      frames.push(store.current() as { kind: string; reason?: string } | null);
      sweepArgs.push(args);
      if (options.throws === true) throw new Error('db down');
      return options.result ?? CLEAN;
    },
  } as unknown as PrivacyOverdueSweepService;

  const recordSweep = vi.fn();
  const metrics = { recordSweep } as unknown as PrivacyOverdueMetrics;

  const runner = new PrivacyOverdueRunner(
    buildEnv(options.env ?? {}),
    scheduler,
    store,
    sweepService,
    metrics,
  );

  return { runner, specs, frames, sweepArgs, recordSweep };
}

describe('PrivacyOverdueRunner', () => {
  it('registers the sweep at the configured interval', async () => {
    const h = makeHarness();

    await h.runner.onModuleInit();

    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]?.queueName).toBe(PRIVACY_OVERDUE_QUEUE_NAME);
    expect(h.specs[0]?.intervalMs).toBe(3_600_000);
  });

  it('lets the scheduler id default to the queue name — this queue is new', async () => {
    // The opposite of the rbac-revoker, whose id predates the default and
    // must be passed explicitly to avoid orphaning a live definition.
    const h = makeHarness();

    await h.runner.onModuleInit();

    expect(h.specs[0]?.schedulerId).toBeUndefined();
  });

  it('hands the kill switch through with the env var that controls it', async () => {
    const h = makeHarness({ env: { PRIVACY_OVERDUE_SWEEP_ENABLED: false } as Partial<Env> });

    await h.runner.onModuleInit();

    expect(h.specs[0]?.enabled).toBe(false);
    expect(h.specs[0]?.disabledBy).toBe('PRIVACY_OVERDUE_SWEEP_ENABLED');
  });

  it('runs the tick inside an EXEMPT tenant frame', async () => {
    // A scheduled sweep has no request and therefore no RequestContext.
    // Identity's Prisma gate is in `enforce` mode, so without this the
    // scan is a hard MissingRequestContextError every tick — a clock
    // nobody watches, silently (CLAUDE.md §3.2).
    const h = makeHarness();

    await h.runner.runSweep();

    expect(h.frames).toEqual([{ kind: 'exempt', reason: 'privacy-overdue-sweep' }]);
  });

  it('drives the scan with the CONFIGURED lead time and enumeration cap', async () => {
    const h = makeHarness({
      env: {
        PRIVACY_OVERDUE_SWEEP_DUE_SOON_DAYS: 14,
        PRIVACY_OVERDUE_SWEEP_MAX_LOGGED: 3,
      } as Partial<Env>,
    });

    await h.runner.runSweep(new Date('2026-07-27T00:00:00.000Z'));

    expect(h.sweepArgs[0]).toEqual({
      now: new Date('2026-07-27T00:00:00.000Z'),
      dueSoonDays: 14,
      maxLogged: 3,
    });
  });

  it('records the metric on a CLEAN tick, zeros included', async () => {
    // An absent series means the worker stopped; a zero series means
    // nothing is late. Only one of those is fine, so both must be
    // distinguishable on the dashboard.
    const h = makeHarness();

    await h.runner.runSweep();

    expect(h.recordSweep).toHaveBeenCalledTimes(1);
    expect(h.recordSweep.mock.calls[0]?.[0]).toBe('ok');
    expect(h.recordSweep.mock.calls[0]?.[1]).toEqual({ overdueCount: 0, dueSoonCount: 0 });
  });

  it('records the overdue and due-soon counts when something is late', async () => {
    const h = makeHarness({ result: LATE });

    await h.runner.runSweep();

    expect(h.recordSweep.mock.calls[0]?.[1]).toEqual({ overdueCount: 2, dueSoonCount: 5 });
  });

  it('records error and rethrows so BullMQ marks the job failed', async () => {
    const h = makeHarness({ throws: true });

    await expect(h.runner.runSweep()).rejects.toThrow('db down');

    expect(h.recordSweep.mock.calls[0]?.[0]).toBe('error');
  });

  it('runs the scan when the scheduler fires its processor', async () => {
    const h = makeHarness();

    await h.runner.onModuleInit();
    await h.specs[0]?.processor();

    expect(h.sweepArgs).toHaveLength(1);
  });
});
