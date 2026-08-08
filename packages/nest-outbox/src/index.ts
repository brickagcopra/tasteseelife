export { OutboxModule } from './module/outbox.module';
export {
  OUTBOX_OPTIONS_TOKEN,
  OUTBOX_CLOCK_TOKEN,
  OUTBOX_ID_GENERATOR_TOKEN,
} from './module/tokens';

export { OutboxService } from './service/outbox.service';
export type { AppendArgs, AppendResult, OutboxRawExecutor } from './service/types';

export { OutboxConfigError, validateOptions } from './config';
export type { OutboxModuleOptions, ValidatedOutboxOptions } from './config';
