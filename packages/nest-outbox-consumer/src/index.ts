export {
  OutboxConsumerModule,
  type OutboxConsumerDependencyFactory,
  type OutboxConsumerModuleSetup,
} from './module/consumer.module';
export {
  OUTBOX_CONSUMER_OPTIONS_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
} from './module/tokens';

export { OutboxConsumerService, type PollSummary } from './service/consumer.service';
export { OutboxConsumerScheduler } from './service/consumer-scheduler';

export { MemoryConsumerDedupStore } from './service/memory-dedup-store';
export { PgConsumerDedupStore } from './service/pg-dedup-store';

export { parseStreamEntry, type ParseResult } from './service/stream-entry-parser';
export {
  asConsumerRedisClient,
  ensureConsumerGroup,
  flattenXreadgroupResponse,
  type ConsumerRedisClient,
} from './service/redis-stream-consumer';

export type {
  ConsumerDedupState,
  ConsumerDedupStore,
  ConsumerEventEnvelope,
  ConsumerHandler,
  ConsumerRawExecutor,
  HandleArgs,
  HandlerRegistration,
  ParsedStreamEntry,
} from './service/types';

export { ConsumerConfigError, validateOptions } from './config';
export type { OutboxConsumerModuleOptions, ValidatedConsumerOptions } from './config';
