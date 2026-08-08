import type { BullMqSchedulerService } from '@taste-and-see/nest-bullmq-scheduler';
import type { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../config/env';
import {
  DUNNING_EXHAUSTION_QUEUE_NAME,
  DUNNING_EXHAUSTION_SCHEDULER_ID,
  DunningExhaustionSweepRunner,
} from './dunning-exhaustion-sweep.runner';
import type { DunningExhaustionSweepService } from './services/dunning-exhaustion-sweep.service';

function build(env?: Partial<Env>) {
  const schedule = vi.fn().mockResolvedValue(undefined);
  const sweep = vi.fn().mockResolvedValue({
    candidates: 0,
    exhausted: 0,
    skipped: 0,
    failed: 0,
    truncated: false,
  });
  const run = vi.fn((_context: unknown, fn: () => Promise<unknown>) => fn());

  const runner = new DunningExhaustionSweepRunner(
    {
      SUBSCRIPTION_DUNNING_SWEEP_ENABLED: true,
      SUBSCRIPTION_DUNNING_SWEEP_INTERVAL_MS: 3_600_000,
      ...env,
    } as unknown as Env,
    { schedule } as unknown as BullMqSchedulerService,
    { sweep } as unknown as DunningExhaustionSweepService,
    { run } as unknown as TenantContextStore,
  );
  return { runner, schedule, sweep, run };
}

describe('DunningExhaustionSweepRunner', () => {
  it('arms the scheduler with the queue name, cadence and kill switch', async () => {
    const { runner, schedule } = build();

    await runner.onModuleInit();

    const options = schedule.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.queueName).toBe(DUNNING_EXHAUSTION_QUEUE_NAME);
    expect(options.intervalMs).toBe(3_600_000);
    expect(options.enabled).toBe(true);
    // The env var NAME, not a boolean — "not running" is only actionable if
    // the operator knows which lever.
    expect(options.disabledBy).toBe('SUBSCRIPTION_DUNNING_SWEEP_ENABLED');
  });

  it('passes the scheduler id EXPLICITLY even though it equals the queue name', async () => {
    // A live repeatable definition orphaned by a rename ticks forever
    // alongside its replacement — double the rate, no way to tell.
    const { runner, schedule } = build();

    await runner.onModuleInit();

    expect((schedule.mock.calls[0]![0] as Record<string, unknown>).schedulerId).toBe(
      DUNNING_EXHAUSTION_SCHEDULER_ID,
    );
  });

  it('propagates a disabled kill switch to the scheduler', async () => {
    const { runner, schedule } = build({
      SUBSCRIPTION_DUNNING_SWEEP_ENABLED: false,
    } as Partial<Env>);

    await runner.onModuleInit();

    expect((schedule.mock.calls[0]![0] as Record<string, unknown>).enabled).toBe(false);
  });

  it('RUNS THE TICK INSIDE runWithoutTenantContext', async () => {
    // The defect this asserts against is invisible to every other test and to
    // production until the first tick: a scheduled job has no RequestContext,
    // this service runs the tenant gate in `enforce`, and an unwrapped tick
    // dies with MissingRequestContextError on its first typed Prisma call.
    // TS-308a-followup-1 found identity's rbac-revoker had been broken on
    // every tick it never ran, exactly this way.
    const { runner, sweep, run } = build();

    await runner.runTick(new Date('2026-08-01T12:00:00.000Z'));

    expect(run).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    const context = run.mock.calls[0]![0] as { reason?: string };
    expect(String(context.reason ?? '')).toContain('dunning-exhaustion-sweep');
  });

  it('hands the tick clock straight through to the sweep', async () => {
    const now = new Date('2026-08-01T12:00:00.000Z');
    const { runner, sweep } = build();

    await runner.runTick(now);

    expect(sweep).toHaveBeenCalledWith({ now });
  });

  it('wires the processor to the tick', async () => {
    const { runner, schedule, sweep } = build();

    await runner.onModuleInit();
    const processor = (schedule.mock.calls[0]![0] as { processor: () => Promise<void> }).processor;
    await processor();

    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
