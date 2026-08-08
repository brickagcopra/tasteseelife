import 'reflect-metadata';

import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import type { ScheduledSweepHandles, ScheduledSweepHandlesArgs } from '../handles';
import { BullMqSchedulerService } from '../scheduler.service';
import { BullMqSchedulerModule } from './bullmq-scheduler.module';
import { BullMqSchedulerConfigError } from './options';
import { BULLMQ_SCHEDULER_HANDLES_FACTORY, BULLMQ_SCHEDULER_OPTIONS_TOKEN } from './tokens';

/**
 * The module is `@Global()` on purpose: a feature module that owns a sweep
 * injects `BullMqSchedulerService` without importing anything, which is how
 * service-identity's `RbacModule` and service-booking's `AnomalyModule`
 * consume it. `SweepOwnerModule` below reproduces exactly that shape — no
 * import of `BullMqSchedulerModule` — so a regression to a non-global
 * module fails here rather than at service boot.
 *
 * `@Inject(BullMqSchedulerService)` rather than the bare parameter type:
 * vitest transpiles with esbuild, which implements `experimentalDecorators`
 * but NOT `emitDecoratorMetadata`, so `design:paramtypes` is absent under
 * test. The real services compile with `tsc`, where the bare type resolves.
 *
 * Every case overrides the handles factory. Compiling the real one would
 * open Redis connections at `schedule()` — the seam exists precisely so
 * that never happens in a unit test.
 */
@Injectable()
class SweepOwner {
  constructor(@Inject(BullMqSchedulerService) readonly scheduler: BullMqSchedulerService) {}
}

@Module({ providers: [SweepOwner] })
class SweepOwnerModule {}

function fakeFactory(calls: ScheduledSweepHandlesArgs[]) {
  return (args: ScheduledSweepHandlesArgs): ScheduledSweepHandles => {
    calls.push(args);
    return { scheduleSweep: async () => {}, close: async () => {} };
  };
}

describe('BullMqSchedulerModule.forRoot', () => {
  it('provides the scheduler to a feature module that never imports it', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BullMqSchedulerModule.forRoot({
          serviceName: 'service-identity',
          environment: 'test',
          redisUrl: 'redis://localhost:6379/0',
        }),
        SweepOwnerModule,
      ],
    })
      .overrideProvider(BULLMQ_SCHEDULER_HANDLES_FACTORY)
      .useValue(fakeFactory([]))
      .compile();

    expect(moduleRef.get(SweepOwner).scheduler).toBeInstanceOf(BullMqSchedulerService);
    await moduleRef.close();
  });

  it('binds the validated options, prefix included, to the options token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BullMqSchedulerModule.forRoot({
          serviceName: 'service-booking',
          environment: 'staging',
          redisUrl: 'redis://cache:6379/2',
        }),
      ],
    })
      .overrideProvider(BULLMQ_SCHEDULER_HANDLES_FACTORY)
      .useValue(fakeFactory([]))
      .compile();

    expect(moduleRef.get(BULLMQ_SCHEDULER_OPTIONS_TOKEN)).toEqual({
      serviceName: 'service-booking',
      environment: 'staging',
      redisUrl: 'redis://cache:6379/2',
      prefix: 'staging:service-booking:queue',
    });
    await moduleRef.close();
  });

  it('the injected scheduler arms through the bound factory', async () => {
    const calls: ScheduledSweepHandlesArgs[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        BullMqSchedulerModule.forRoot({
          serviceName: 'service-identity',
          environment: 'test',
          redisUrl: 'redis://localhost:6379/0',
        }),
        SweepOwnerModule,
      ],
    })
      .overrideProvider(BULLMQ_SCHEDULER_HANDLES_FACTORY)
      .useValue(fakeFactory(calls))
      .compile();

    await moduleRef.get(SweepOwner).scheduler.schedule({
      queueName: 'rbac-revoker',
      intervalMs: 1_000,
      enabled: true,
      disabledBy: 'RBAC_REVOKER_ENABLED',
      processor: async () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.prefix).toBe('test:service-identity:queue');
    await moduleRef.close();
  });

  it('fails at module-definition time on bad configuration, before boot', () => {
    expect(() =>
      BullMqSchedulerModule.forRoot({
        serviceName: 'service-identity',
        environment: 'test',
        redisUrl: 'postgres://nope',
      }),
    ).toThrow(BullMqSchedulerConfigError);
  });
});
