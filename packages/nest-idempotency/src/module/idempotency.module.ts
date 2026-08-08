import { type DynamicModule, Global, Logger, Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Redis as IoRedisClient } from 'ioredis';

import { validateOptions, type IdempotencyModuleOptions, type ValidatedOptions } from '../config';
import { IdempotencyInterceptor } from '../interceptors/idempotency.interceptor';
import { IdempotencyMetrics } from '../observability/idempotency-metrics';
import { MemoryIdempotencyStore } from '../store/memory-store';
import { RedisIdempotencyStore } from '../store/redis-store';
import type { IdempotencyStore } from '../store/types';
import {
  IDEMPOTENCY_OPTIONS_TOKEN,
  IDEMPOTENCY_REDIS_TOKEN,
  IDEMPOTENCY_STORE_TOKEN,
} from './tokens';

/**
 * Wires the idempotency cache + interceptor into a Nest application.
 *
 * The module is `@Global()` so consumers don't have to re-import it
 * from every feature module. The interceptor is registered via
 * `APP_INTERCEPTOR` so every controller method flagged with
 * `@Idempotent()` is covered automatically.
 *
 * Three backend modes:
 *
 *   `redis-url` — production. The module builds and owns an ioredis
 *     client, hooked into Nest's `onApplicationShutdown` lifecycle so
 *     deployments don't leak connections.
 *
 *   `redis-client` — production with a pre-built shared client. The
 *     module does NOT call `.quit()` — the consumer manages lifecycle.
 *
 *   `store` — escape hatch for tests / custom adapters. Pass a
 *     pre-constructed `IdempotencyStore`. This is how the consuming
 *     service-subscription tests override the store with
 *     `MemoryIdempotencyStore` (or a fake that surfaces `unavailable`).
 *
 * @example
 *
 *   ```ts
 *   imports: [
 *     IdempotencyModule.forRoot({
 *       environment: 'prod',
 *       serviceName: 'service-subscription',
 *       backend: { kind: 'redis-url', redisUrl: env.REDIS_URL },
 *     }),
 *   ],
 *   ```
 */
@Global()
@Module({})
export class IdempotencyModule {
  static forRoot(options: IdempotencyModuleOptions): DynamicModule {
    const validated = validateOptions(options);

    const optionsProvider: Provider = {
      provide: IDEMPOTENCY_OPTIONS_TOKEN,
      useValue: validated,
    };

    const providers: Provider[] = [optionsProvider];
    const exports: Array<symbol | typeof IdempotencyInterceptor> = [
      IDEMPOTENCY_OPTIONS_TOKEN,
      IDEMPOTENCY_STORE_TOKEN,
    ];

    if (validated.backend.kind === 'redis-url') {
      const { redisUrl } = validated.backend;
      const redisProvider: Provider = {
        provide: IDEMPOTENCY_REDIS_TOKEN,
        useFactory: (): IoRedisClient => {
          const client = new IoRedisClient(redisUrl, {
            // Don't queue commands forever when Redis is down — fail
            // fast and let the interceptor degrade to "proceed without
            // cache". CLAUDE.md §4.3.
            maxRetriesPerRequest: 1,
            lazyConnect: false,
            enableOfflineQueue: false,
          });
          const log = new Logger('IdempotencyModule.redis');
          client.on('error', (err) => log.warn(`redis client error: ${err.message}`));
          return client;
        },
      };
      const storeProvider: Provider = {
        provide: IDEMPOTENCY_STORE_TOKEN,
        useFactory: (client: IoRedisClient, opts: ValidatedOptions): IdempotencyStore =>
          new RedisIdempotencyStore(
            client,
            opts.ttlSeconds,
            opts.inFlightTtlSeconds,
            new Logger('IdempotencyStore'),
          ),
        inject: [IDEMPOTENCY_REDIS_TOKEN, IDEMPOTENCY_OPTIONS_TOKEN],
      };
      providers.push(redisProvider, storeProvider);
      exports.push(IDEMPOTENCY_REDIS_TOKEN);
    } else if (validated.backend.kind === 'redis-client') {
      const client = validated.backend.redisClient as IoRedisClient;
      const redisProvider: Provider = {
        provide: IDEMPOTENCY_REDIS_TOKEN,
        useValue: client,
      };
      const storeProvider: Provider = {
        provide: IDEMPOTENCY_STORE_TOKEN,
        useFactory: (opts: ValidatedOptions): IdempotencyStore =>
          new RedisIdempotencyStore(
            client,
            opts.ttlSeconds,
            opts.inFlightTtlSeconds,
            new Logger('IdempotencyStore'),
          ),
        inject: [IDEMPOTENCY_OPTIONS_TOKEN],
      };
      providers.push(redisProvider, storeProvider);
      exports.push(IDEMPOTENCY_REDIS_TOKEN);
    } else {
      const explicit = validated.backend.store;
      providers.push({
        provide: IDEMPOTENCY_STORE_TOKEN,
        useValue: explicit,
      });
    }

    // Registered so Nest DI satisfies the interceptor's `IdempotencyMetrics`
    // constructor dependency (TS-044-followup-4). The instruments bind to a
    // no-op meter until the consuming service calls `initMetrics`.
    providers.push(IdempotencyMetrics);

    providers.push({
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    });

    return {
      module: IdempotencyModule,
      providers,
      exports,
    };
  }
}

// Re-export the in-memory store so consumers can override the store via
// `Test.createTestingModule(...).overrideProvider(IDEMPOTENCY_STORE_TOKEN)`.
export { MemoryIdempotencyStore };
