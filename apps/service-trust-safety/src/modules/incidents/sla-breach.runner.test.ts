import 'reflect-metadata';

import type {
  BullMqSchedulerService,
  ScheduledSweepSpec,
} from '@taste-and-see/nest-bullmq-scheduler';
import { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import { SlaBreachMetrics } from './services/sla-breach-metrics';
import { SLA_BREACH_QUEUE_NAME, SlaBreachRunner } from './sla-breach.runner';
import type {
  SlaBreachSweepResult,
  SlaBreachSweepService,
} from './services/sla-breach-sweep.service';

/**
 * Unit tests for the SLA-breach runner (TS-306-followup-1a).
 *
 * Constructed directly — vitest/esbuild emits no `design:paramtypes`.
 *
 * The load-bearing assertions:
 *   - **it never pages.** The runner is given no pager at all, which is
 *     the structural version of the decision: paging on breach is
 *     TS-306-followup-1b and stays blocked on TS-300-followup-3's
 *     unconfirmed budgets;
 *   - the tick runs inside an EXEMPT tenant frame (the gate is in
 *     enforce mode, so an unwrapped scheduled query never runs).
 */

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    REDIS_URL: 'redis://localhost:6379/0',
    TRUST_SAFETY_SLA_SWEEP_ENABLED: true,
    TRUST_SAFETY_SLA_SWEEP_INTERVAL_MS: 900_000,
    TRUST_SAFETY_SLA_SWEEP_MAX_LOGGED: 25,
    ...overrides,
  } as unknown as Env;
}

const CLEAN: SlaBreachSweepResult = {
  breachedCount: 0,
  dueSoonCount: 0,
  rows: [],
  truncated: false,
};

const BREACHED: SlaBreachSweepResult = {
  breachedCount: 2,
  dueSoonCount: 4,
  truncated: false,
  rows: [
    {
      id: 'inc_1',
      severity: 'high',
      category: 'welfare',
      status: 'open',
      slaDueAt: new Date('2026-07-27T04:00:00.000Z'),
      minutesOverdue: 480,
      budgetMinutes: 480,
    },
  ],
};

function makeHarness(
  options: {
    readonly env?: Partial<Env>;
    readonly result?: SlaBreachSweepResult;
    readonly throws?: boolean;
  } = {},
) {
  const specs: ScheduledSweepSpec[] = [];
  const frames: Array<{ kind: string; reason?: string } | null> = [];
  const sweepArgs: Array<{ now: Date; maxLogged: number }> = [];
  const store = new TenantContextStore();

  const scheduler = {
    schedule: async (spec: ScheduledSweepSpec) => {
      specs.push(spec);
    },
  } as unknown as BullMqSchedulerService;

  const sweepService = {
    sweep: async (args: { now: Date; maxLogged: number }) => {
      frames.push(store.current() as { kind: string; reason?: string } | null);
      sweepArgs.push(args);
      if (options.throws === true) throw new Error('db down');
      return options.result ?? CLEAN;
    },
  } as unknown as SlaBreachSweepService;

  // The real instrument class (TS-306-followup-1c): `getMeter` returns a
  // no-op meter with no SDK booted, so it is free to construct and the spy
  // is what makes the recorded values assertable.
  const metrics = new SlaBreachMetrics();
  const recordSweep = vi.spyOn(metrics, 'recordSweep');

  const runner = new SlaBreachRunner(
    buildEnv(options.env ?? {}),
    scheduler,
    store,
    sweepService,
    metrics,
  );

  return { runner, specs, frames, sweepArgs, recordSweep };
}

describe('SlaBreachRunner', () => {
  it('registers the sweep at the configured interval', async () => {
    const h = makeHarness();

    await h.runner.onModuleInit();

    expect(h.specs).toHaveLength(1);
    expect(h.specs[0]?.queueName).toBe(SLA_BREACH_QUEUE_NAME);
    expect(h.specs[0]?.intervalMs).toBe(900_000);
  });

  it('hands the kill switch through with the env var that controls it', async () => {
    const h = makeHarness({ env: { TRUST_SAFETY_SLA_SWEEP_ENABLED: false } as Partial<Env> });

    await h.runner.onModuleInit();

    expect(h.specs[0]?.enabled).toBe(false);
    expect(h.specs[0]?.disabledBy).toBe('TRUST_SAFETY_SLA_SWEEP_ENABLED');
  });

  it('runs the tick inside an EXEMPT tenant frame', async () => {
    const h = makeHarness();

    await h.runner.runSweep();

    expect(h.frames).toEqual([{ kind: 'exempt', reason: 'trust-safety-sla-breach-sweep' }]);
  });

  it('scans on a clean queue too, rather than short-circuiting', async () => {
    // "Nothing has breached" is a result the sweep must actually produce
    // each tick, not an absence.
    const h = makeHarness();

    await h.runner.runSweep();

    expect(h.sweepArgs).toHaveLength(1);
  });

  it('DOES NOT PAGE, even on a breach', async () => {
    // Structural, not behavioural: the runner takes no pager, so paging
    // on a placeholder deadline is not something a future edit can add
    // by accident. Paging on breach is TS-306-followup-1b, and it is
    // blocked on TS-300-followup-3 confirming the budgets.
    const h = makeHarness({ result: BREACHED });

    await h.runner.runSweep();

    expect(Object.getOwnPropertyNames(h.runner)).not.toContain('pager');
  });

  it('drives the scan with the CONFIGURED enumeration cap and clock', async () => {
    const h = makeHarness({ env: { TRUST_SAFETY_SLA_SWEEP_MAX_LOGGED: 3 } as Partial<Env> });

    await h.runner.runSweep(new Date('2026-07-27T00:00:00.000Z'));

    expect(h.sweepArgs[0]).toEqual({
      now: new Date('2026-07-27T00:00:00.000Z'),
      maxLogged: 3,
    });
  });

  it('rethrows a failed scan so BullMQ marks the job failed', async () => {
    // The scheduler keeps its next tick either way, so a transient
    // failure costs one sweep rather than the sweep.
    const h = makeHarness({ throws: true });

    await expect(h.runner.runSweep()).rejects.toThrow('db down');
  });

  it('runs the scan when the scheduler fires its processor', async () => {
    const h = makeHarness();

    await h.runner.onModuleInit();
    await h.specs[0]?.processor();

    expect(h.sweepArgs).toHaveLength(1);
  });
});

describe('SlaBreachRunner — metrics (TS-306-followup-1c)', () => {
  it('records the counts on a breach', async () => {
    const h = makeHarness({ result: BREACHED });

    await h.runner.runSweep();

    expect(h.recordSweep).toHaveBeenCalledTimes(1);
    expect(h.recordSweep).toHaveBeenCalledWith(
      'ok',
      { breachedCount: 2, dueSoonCount: 4 },
      expect.any(Number),
    );
  });

  it('records a CLEAN sweep too — an absent series and a zero mean opposite things', async () => {
    // "Nothing is late" and "nobody is checking" must not look the same on
    // the dashboard, which is the whole reason the zero is recorded.
    const h = makeHarness();

    await h.runner.runSweep();

    expect(h.recordSweep).toHaveBeenCalledTimes(1);
    expect(h.recordSweep).toHaveBeenCalledWith(
      'ok',
      { breachedCount: 0, dueSoonCount: 0 },
      expect.any(Number),
    );
  });

  it('records the UNCAPPED breach count, not the enumerated rows', async () => {
    // The sweep runs count and enumeration as separate queries precisely so
    // a truncated log cannot make the alerting series under-report;
    // recording `rows.length` here would undo that.
    const h = makeHarness({
      result: { ...BREACHED, breachedCount: 97, truncated: true },
    });

    await h.runner.runSweep();

    expect(h.recordSweep.mock.calls[0]?.[1]).toEqual({ breachedCount: 97, dueSoonCount: 4 });
    expect(BREACHED.rows).toHaveLength(1);
  });

  it('records an `error` outcome when the scan throws, with no counts', async () => {
    // A zero on the error path would be indistinguishable from a clean
    // sweep on the very series ops alerts against — so the counts are
    // recorded as zero and the OUTCOME is what carries the difference.
    const h = makeHarness({ throws: true });

    await expect(h.runner.runSweep()).rejects.toThrow('db down');

    expect(h.recordSweep).toHaveBeenCalledTimes(1);
    expect(h.recordSweep).toHaveBeenCalledWith(
      'error',
      { breachedCount: 0, dueSoonCount: 0 },
      expect.any(Number),
    );
  });

  it('carries NO incident id, severity or category into the metric', async () => {
    // The per-incident WARN lines carry those for the operator reading the
    // log; this series is what an alert fires on, and an alert body that
    // names the severity of a live welfare concern routes the shape of a
    // report to phones.
    const h = makeHarness({ result: BREACHED });

    await h.runner.runSweep();

    const serialised = JSON.stringify(h.recordSweep.mock.calls);
    expect(serialised).not.toContain('inc_1');
    expect(serialised).not.toContain('welfare');
  });
});
