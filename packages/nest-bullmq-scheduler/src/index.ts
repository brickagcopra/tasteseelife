export { redisConnectionOptionsFromUrl } from './redis-connection';

export { createBullMqScheduledSweepHandles } from './handles';
export type {
  ScheduledSweepHandles,
  ScheduledSweepHandlesArgs,
  ScheduledSweepHandlesFactory,
} from './handles';

export { BullMqSchedulerService } from './scheduler.service';
export type { ScheduledSweepSpec, SweepLogDetail } from './scheduler.service';

export { BullMqSchedulerModule } from './module/bullmq-scheduler.module';
export { BULLMQ_SCHEDULER_HANDLES_FACTORY, BULLMQ_SCHEDULER_OPTIONS_TOKEN } from './module/tokens';
export { BullMqSchedulerConfigError, validateBullMqSchedulerOptions } from './module/options';
export type {
  BullMqSchedulerModuleOptions,
  ValidatedBullMqSchedulerOptions,
} from './module/options';
