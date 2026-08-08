import { describe, expect, it, vi } from 'vitest';

import type { ScheduledSweepHandles, ScheduledSweepHandlesArgs } from './handles';
import { BullMqSchedulerConfigError, validateBullMqSchedulerOptions } from './module/options';
import { BullMqSchedulerService } from './scheduler.service';

/**
 * The handles factory is faked throughout — a unit test must never open a
 * Redis connection, which is the whole reason the seam exists. The
 * real-BullMQ path is Docker-gated integration scope.
 *
 * Constructed DIRECTLY rather than through `Test.createTestingModule`:
 * vitest/esbuild emits no `design:paramtypes`, so bare-param-type
 * injection resolves to `undefined` under this runner. (This service uses
 * `@Inject(...)` on both parameters, so it WOULD resolve — but the host
 * suites that mirror this file construct directly for that reason, and one
 * shape across the fleet is worth more than the shortcut.)
 */
interface Harness {
  readonly service: BullMqSchedulerService;
  readonly calls: ScheduledSweepHandlesArgs[];
  readonly scheduled: Array<{ queueName: string; intervalMs: number }>;
  readonly closed: string[];
}

function makeHarness(options: { readonly closeThrowsFor?: string } = {}): Harness {
  const calls: ScheduledSweepHandlesArgs[] = [];
  const scheduled: Array<{ queueName: string; intervalMs: number }> = [];
  const closed: string[] = [];

  const service = new BullMqSchedulerService(
    validateBullMqSchedulerOptions({
      serviceName: 'service-identity',
      environment: 'test',
      redisUrl: 'redis://localhost:6379/0',
    }),
    (args): ScheduledSweepHandles => {
      calls.push(args);
      return {
        scheduleSweep: async (intervalMs: number) => {
          scheduled.push({ queueName: args.queueName, intervalMs });
        },
        close: async () => {
          closed.push(args.queueName);
          if (options.closeThrowsFor === args.queueName) throw new Error('redis gone');
        },
      };
    },
  );

  return { service, calls, scheduled, closed };
}

function spec(
  overrides: Partial<Parameters<BullMqSchedulerService['schedule']>[0]> = {},
): Parameters<BullMqSchedulerService['schedule']>[0] {
  return {
    queueName: 'rbac-revoker',
    intervalMs: 300_000,
    enabled: true,
    disabledBy: 'RBAC_REVOKER_ENABLED',
    processor: async () => {},
    ...overrides,
  };
}

describe('BullMqSchedulerService.schedule', () => {
  it('arms the queue with the derived §3.7 prefix and the configured interval', async () => {
    const h = makeHarness();

    await h.service.schedule(spec());

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.prefix).toBe('test:service-identity:queue');
    expect(h.calls[0]?.redisUrl).toBe('redis://localhost:6379/0');
    expect(h.scheduled).toEqual([{ queueName: 'rbac-revoker', intervalMs: 300_000 }]);
  });

  it('defaults the scheduler id to the queue name', async () => {
    const h = makeHarness();

    await h.service.schedule(spec());

    expect(h.calls[0]?.schedulerId).toBe('rbac-revoker');
  });

  it('honours an explicit scheduler id — hosts carry one to preserve a live repeatable definition', async () => {
    const h = makeHarness();

    await h.service.schedule(spec({ schedulerId: 'rbac-revoker-sweep' }));

    expect(h.calls[0]?.schedulerId).toBe('rbac-revoker-sweep');
  });

  it('CREATES NO QUEUE when the kill switch is off', async () => {
    const h = makeHarness();

    await h.service.schedule(spec({ enabled: false }));

    expect(h.calls).toHaveLength(0);
    expect(h.scheduled).toHaveLength(0);
    expect(h.service.isScheduled('rbac-revoker')).toBe(false);
  });

  it('a disabled sweep does not reserve the queue name — it can still be armed later', async () => {
    const h = makeHarness();

    await h.service.schedule(spec({ enabled: false }));
    await h.service.schedule(spec());

    expect(h.calls).toHaveLength(1);
  });

  it('passes the host processor through untouched', async () => {
    const h = makeHarness();
    const processor = vi.fn(async () => {});

    await h.service.schedule(spec({ processor }));
    await h.calls[0]?.processor();

    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('the onFailed hook logs and never throws — a BullMQ job failure must not crash the worker', async () => {
    const h = makeHarness();

    await h.service.schedule(spec());

    expect(() => h.calls[0]?.onFailed('sweep', new Error('redis hiccup'))).not.toThrow();
    expect(() => h.calls[0]?.onFailed(undefined, new Error('no job name'))).not.toThrow();
  });

  it('REJECTS a second registration of the same queue name in one process', async () => {
    // Two workers on one queue means two sweeps per tick. In Redis the
    // upsert is idempotent, so this bug would be invisible there — the
    // only place it can be caught is here.
    const h = makeHarness();

    await h.service.schedule(spec());

    await expect(h.service.schedule(spec())).rejects.toThrow(BullMqSchedulerConfigError);
  });

  it('allows several distinct queues in one service', async () => {
    const h = makeHarness();

    await h.service.schedule(spec());
    await h.service.schedule(spec({ queueName: 'dsar-overdue-sweep', disabledBy: 'X_ENABLED' }));

    expect(h.calls.map((c) => c.queueName)).toEqual(['rbac-revoker', 'dsar-overdue-sweep']);
    expect(h.service.isScheduled('dsar-overdue-sweep')).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a non-positive-integer interval (%s)',
    async (intervalMs) => {
      const h = makeHarness();

      await expect(h.service.schedule(spec({ intervalMs }))).rejects.toThrow(
        BullMqSchedulerConfigError,
      );
    },
  );

  it('rejects an empty queue name', async () => {
    const h = makeHarness();

    await expect(h.service.schedule(spec({ queueName: '  ' }))).rejects.toThrow(
      BullMqSchedulerConfigError,
    );
  });

  it('exposes the prefix so a host can assert its own namespace', () => {
    expect(makeHarness().service.prefix).toBe('test:service-identity:queue');
  });
});

describe('BullMqSchedulerService.onApplicationShutdown', () => {
  it('closes every armed queue', async () => {
    const h = makeHarness();
    await h.service.schedule(spec());
    await h.service.schedule(spec({ queueName: 'dsar-overdue-sweep', disabledBy: 'X_ENABLED' }));

    await h.service.onApplicationShutdown();

    expect(h.closed).toEqual(['rbac-revoker', 'dsar-overdue-sweep']);
  });

  it('is a no-op when nothing ever armed', async () => {
    const h = makeHarness();

    await expect(h.service.onApplicationShutdown()).resolves.toBeUndefined();
    expect(h.closed).toHaveLength(0);
  });

  it('does not double-close on a repeated shutdown', async () => {
    const h = makeHarness();
    await h.service.schedule(spec());

    await h.service.onApplicationShutdown();
    await h.service.onApplicationShutdown();

    expect(h.closed).toEqual(['rbac-revoker']);
  });

  it('swallows a failing close so a shutdown is never blocked by Redis', async () => {
    const h = makeHarness({ closeThrowsFor: 'rbac-revoker' });
    await h.service.schedule(spec());

    await expect(h.service.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('a failing close does not skip the remaining queues', async () => {
    const h = makeHarness({ closeThrowsFor: 'rbac-revoker' });
    await h.service.schedule(spec());
    await h.service.schedule(spec({ queueName: 'dsar-overdue-sweep', disabledBy: 'X_ENABLED' }));

    await h.service.onApplicationShutdown();

    expect(h.closed).toEqual(['rbac-revoker', 'dsar-overdue-sweep']);
  });

  it('a sweep can be re-armed after shutdown — the name is released', async () => {
    const h = makeHarness();
    await h.service.schedule(spec());
    await h.service.onApplicationShutdown();

    await expect(h.service.schedule(spec())).resolves.toBeUndefined();
  });
});
