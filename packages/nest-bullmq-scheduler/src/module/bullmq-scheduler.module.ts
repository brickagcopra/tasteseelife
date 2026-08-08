import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';

import { createBullMqScheduledSweepHandles } from '../handles';
import { BullMqSchedulerService } from '../scheduler.service';
import { type BullMqSchedulerModuleOptions, validateBullMqSchedulerOptions } from './options';
import { BULLMQ_SCHEDULER_HANDLES_FACTORY, BULLMQ_SCHEDULER_OPTIONS_TOKEN } from './tokens';

/**
 * Wires the shared in-service sweep scheduler into a Nest application.
 *
 * `@Global()` for the same reason `PagerDutyModule` and `AuditModule` are:
 * the runners that use it are scattered across feature modules, and an
 * `imports: [BullMqSchedulerModule]` line in each is a line that gets
 * forgotten in exactly the module that needed it.
 *
 * Options are validated eagerly at module-definition time — a bad
 * `REDIS_URL` or an empty prefix segment fails the boot, not the first
 * tick fifteen minutes later.
 *
 * @example
 *
 *   ```ts
 *   imports: [
 *     BullMqSchedulerModule.forRoot({
 *       serviceName: 'service-identity',
 *       environment: env.NODE_ENV,
 *       redisUrl: env.REDIS_URL,
 *     }),
 *   ]
 *   ```
 */
@Global()
@Module({})
export class BullMqSchedulerModule {
  static forRoot(options: BullMqSchedulerModuleOptions): DynamicModule {
    const validated = validateBullMqSchedulerOptions(options);

    const optionsProvider: Provider = {
      provide: BULLMQ_SCHEDULER_OPTIONS_TOKEN,
      useValue: validated,
    };
    const factoryProvider: Provider = {
      provide: BULLMQ_SCHEDULER_HANDLES_FACTORY,
      useValue: createBullMqScheduledSweepHandles,
    };

    return {
      module: BullMqSchedulerModule,
      providers: [optionsProvider, factoryProvider, BullMqSchedulerService],
      exports: [
        BULLMQ_SCHEDULER_OPTIONS_TOKEN,
        BULLMQ_SCHEDULER_HANDLES_FACTORY,
        BullMqSchedulerService,
      ],
    };
  }
}
