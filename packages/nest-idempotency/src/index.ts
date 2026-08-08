export { Idempotent, IDEMPOTENT_METADATA } from './decorators/idempotent.decorator';

export { IdempotencyModule } from './module/idempotency.module';
export {
  IDEMPOTENCY_OPTIONS_TOKEN,
  IDEMPOTENCY_REDIS_TOKEN,
  IDEMPOTENCY_STORE_TOKEN,
} from './module/tokens';

export { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';

export { elapsedSeconds, IdempotencyMetrics } from './observability/idempotency-metrics';
export type { IdempotencyDecision } from './observability/idempotency-metrics';

export { IdempotencyConfigError, validateOptions } from './config';
export type { ActorRequest, IdempotencyModuleOptions, ValidatedOptions } from './config';

export { MemoryIdempotencyStore } from './store/memory-store';
export { RedisIdempotencyStore } from './store/redis-store';

export { formatIdempotencyKey, hashRequestBody } from './store/key';

export type { ClaimOutcome, CompletedRecord, IdempotencyStore } from './store/types';
