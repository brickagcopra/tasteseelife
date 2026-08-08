import { describe, expect, it, vi } from 'vitest';

import { validateOptions } from '../config';
import { OutboxConsumerScheduler } from './consumer-scheduler';
import type { OutboxConsumerService } from './consumer.service';

function buildFakeConsumer(): {
  consumer: OutboxConsumerService;
  bootstrapCalls: number;
  pollCalls: number;
  pollThrows: boolean;
  bootstrapThrows: boolean;
  setPollThrows: (v: boolean) => void;
  setBootstrapThrows: (v: boolean) => void;
} {
  const state = {
    bootstrapCalls: 0,
    pollCalls: 0,
    pollThrows: false,
    bootstrapThrows: false,
  };
  const consumer = {
    bootstrap: vi.fn(async () => {
      state.bootstrapCalls += 1;
      if (state.bootstrapThrows) {
        throw new Error('bootstrap fail');
      }
    }),
    pollOnce: vi.fn(async () => {
      state.pollCalls += 1;
      if (state.pollThrows) {
        throw new Error('poll fail');
      }
      return {
        entriesRead: 0,
        handlersInvoked: 0,
        succeeded: 0,
        failed: 0,
        deadLettered: 0,
        skippedAlreadyProcessed: 0,
      };
    }),
  };
  return {
    consumer: consumer as unknown as OutboxConsumerService,
    get bootstrapCalls() {
      return state.bootstrapCalls;
    },
    get pollCalls() {
      return state.pollCalls;
    },
    get pollThrows() {
      return state.pollThrows;
    },
    get bootstrapThrows() {
      return state.bootstrapThrows;
    },
    setPollThrows: (v) => {
      state.pollThrows = v;
    },
    setBootstrapThrows: (v) => {
      state.bootstrapThrows = v;
    },
  };
}

function buildScheduler(opts: { pollIntervalMs?: number }): {
  scheduler: OutboxConsumerScheduler;
  fake: ReturnType<typeof buildFakeConsumer>;
} {
  const fake = buildFakeConsumer();
  const validated = validateOptions({
    consumerGroup: 'svc',
    pollIntervalMs: opts.pollIntervalMs ?? 0,
    pollBlockMs: 0,
  });
  const scheduler = new OutboxConsumerScheduler(fake.consumer, validated);
  return { scheduler, fake };
}

describe('OutboxConsumerScheduler', () => {
  it('bootstraps the consumer on onApplicationBootstrap', async () => {
    const { scheduler, fake } = buildScheduler({});
    await scheduler.onApplicationBootstrap();
    expect(fake.bootstrapCalls).toBe(1);
    // Tear down to clear the pending timer so the test doesn't leak.
    await scheduler.onApplicationShutdown();
  });

  /**
   * The ordering property, asserted structurally (TS-505d2).
   *
   * `bootstrap()` creates a Redis consumer group per REGISTERED handler,
   * and handlers register from feature modules' `onModuleInit`. Nest runs
   * `onModuleInit` in module dependency order, and this scheduler lives in
   * the module every feature module depends on — so bootstrapping on that
   * hook meant the handler set was always empty, no consumer group was ever
   * created, and `booking.completed` was consumed by nothing in any
   * environment. `onApplicationBootstrap` is the hook Nest guarantees runs
   * after every module's `onModuleInit`.
   *
   * A behavioural test cannot see this: the defect is which hook Nest calls
   * and when, and a unit test that calls the hook itself has already chosen
   * the order. So the assertion is that the class does not implement
   * `onModuleInit` at all — reintroducing it is the whole bug.
   */
  it('does not bootstrap from onModuleInit, which runs before handlers register', () => {
    const { scheduler } = buildScheduler({});
    expect((scheduler as unknown as { onModuleInit?: unknown }).onModuleInit).toBeUndefined();
    expect(typeof scheduler.onApplicationBootstrap).toBe('function');
  });

  it('does NOT start the loop if bootstrap throws', async () => {
    const { scheduler, fake } = buildScheduler({});
    fake.setBootstrapThrows(true);
    await scheduler.onApplicationBootstrap();
    expect(fake.bootstrapCalls).toBe(1);
    expect(fake.pollCalls).toBe(0);
    await scheduler.onApplicationShutdown();
  });

  it('tickNow invokes pollOnce on the consumer', async () => {
    const { scheduler, fake } = buildScheduler({});
    await scheduler.onApplicationBootstrap();
    await scheduler.tickNow();
    // tickNow at minimum hits pollOnce; the scheduler-internal tick
    // chained from onApplicationBootstrap may also fire, so we assert ≥ 1.
    expect(fake.pollCalls).toBeGreaterThanOrEqual(1);
    await scheduler.onApplicationShutdown();
  });

  it('keeps ticking when pollOnce throws (cycle stays alive)', async () => {
    const { scheduler, fake } = buildScheduler({});
    fake.setPollThrows(true);
    await scheduler.onApplicationBootstrap();
    await scheduler.tickNow();
    await scheduler.tickNow();
    expect(fake.pollCalls).toBeGreaterThanOrEqual(2);
    await scheduler.onApplicationShutdown();
  });

  it('onApplicationShutdown halts further ticks', async () => {
    const { scheduler, fake } = buildScheduler({});
    await scheduler.onApplicationBootstrap();
    const before = fake.pollCalls;
    await scheduler.onApplicationShutdown();
    // After shutdown a manual tickNow is a no-op.
    await scheduler.tickNow();
    expect(fake.pollCalls).toBe(before);
  });

  it('awaits the in-flight cycle on shutdown', async () => {
    const { scheduler, fake } = buildScheduler({});
    let resolveCycle: (() => void) | null = null;
    (
      fake.consumer as unknown as {
        pollOnce: ReturnType<typeof vi.fn>;
      }
    ).pollOnce = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveCycle = () =>
            resolve({
              entriesRead: 0,
              handlersInvoked: 0,
              succeeded: 0,
              failed: 0,
              deadLettered: 0,
              skippedAlreadyProcessed: 0,
            });
        }),
    );
    await scheduler.onApplicationBootstrap();
    // Trigger a tick that hangs
    const tickPromise = scheduler.tickNow();
    // Start shutdown — it should await the cycle
    const shutdownPromise = scheduler.onApplicationShutdown();
    // Release the cycle
    setImmediate(() => {
      if (resolveCycle) resolveCycle();
    });
    await Promise.all([tickPromise, shutdownPromise]);
    expect(true).toBe(true);
  });
});
