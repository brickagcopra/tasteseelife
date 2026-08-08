import {
  type DynamicModule,
  type FactoryProvider,
  Global,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';

import { type OutboxConsumerModuleOptions, validateOptions } from '../config';
import { OutboxConsumerScheduler } from '../service/consumer-scheduler';
import { OutboxConsumerService } from '../service/consumer.service';
import type { ConsumerRedisClient } from '../service/redis-stream-consumer';
import type { ConsumerDedupStore } from '../service/types';
import {
  OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
  OUTBOX_CONSUMER_OPTIONS_TOKEN,
  OUTBOX_CONSUMER_REDIS_TOKEN,
} from './tokens';

/**
 * A `useFactory` + `inject` pair for one of the SDK's two dependencies.
 *
 * Structurally Nest's own `FactoryProvider` minus `provide` — the SDK
 * fills that in, so a consumer cannot bind the factory to the wrong
 * token.
 */
export type OutboxConsumerDependencyFactory<T> = Pick<FactoryProvider<T>, 'useFactory' | 'inject'>;

/**
 * Everything `forRoot` needs: the tuning options plus the two
 * dependencies `OutboxConsumerService` injects.
 *
 * `redis` and `dedupStore` are **required**. See ADR-0005: optional
 * would leave every call site compiling and still broken, which is the
 * TS-506 failure itself.
 */
export type OutboxConsumerModuleSetup = OutboxConsumerModuleOptions & {
  /**
   * Modules whose exports the two factories inject from — typically the
   * service's config module (for `ENV_TOKEN`) and its Prisma module.
   */
  readonly imports?: ModuleMetadata['imports'];
  /** Builds the ioredis client used for XREADGROUP / XAUTOCLAIM / XACK. */
  readonly redis: OutboxConsumerDependencyFactory<ConsumerRedisClient>;
  /** Builds the dedup store — `PgConsumerDedupStore` in every service. */
  readonly dedupStore: OutboxConsumerDependencyFactory<ConsumerDedupStore>;
};

/**
 * Wires the consumer SDK into a Nest application.
 *
 * The module is `@Global()` so feature modules can `@Inject` the
 * `OutboxConsumerService` without re-importing.
 *
 * **The SDK module declares its own dependency providers (ADR-0005).**
 * `OutboxConsumerService` injects `OUTBOX_CONSUMER_REDIS_TOKEN` and
 * `OUTBOX_CONSUMER_DEDUP_STORE_TOKEN`; Nest resolves a provider's
 * dependencies in the scope of the module that **declares** it, so both
 * tokens must be declared here, alongside the service. They previously
 * were not — this module's doc-block told consumers to provide them in
 * their own modules, all five did, and all five died in the injector
 * before binding a port (TS-506). `@Global()` widens where the SDK's
 * *exports* can be consumed; it does not widen where the SDK's *own*
 * dependencies can be found.
 *
 * The factory bodies still live in the consuming service — that is what
 * keeps `ioredis` and `@prisma/client` out of this package, and what
 * lets a pod share one ioredis client between this SDK and the
 * idempotency cache.
 *
 * @example
 *
 *   ```ts
 *   imports: [
 *     OutboxConsumerModule.forRoot({
 *       consumerGroup: 'service-accounting',
 *       consumerName: env.OUTBOX_CONSUMER_NAME,
 *       imports: [AppConfigModule, PrismaModule],
 *       redis: {
 *         useFactory: (env: Env) => new Redis(env.REDIS_URL, { lazyConnect: true }),
 *         inject: [ENV_TOKEN],
 *       },
 *       dedupStore: {
 *         useFactory: (prisma: PrismaService) =>
 *           new PgConsumerDedupStore(prisma, 'accounting'),
 *         inject: [PrismaService],
 *       },
 *     }),
 *   ],
 *   ```
 *
 * Each feature module then calls
 * `consumer.registerHandler(EVENT_NAME, handler)` from its
 * `OnModuleInit` to subscribe.
 *
 * A test that wants the in-memory dedup store passes it like any other,
 * which reads the same as production:
 * `dedupStore: { useFactory: () => new MemoryConsumerDedupStore() }`.
 * (The former `useMemoryDedupStore: boolean` flag is gone — it had no
 * callers, and providing *one* of the two tokens from inside the SDK is
 * what made the broken contract read as plausible.)
 */
@Global()
@Module({})
export class OutboxConsumerModule {
  static forRoot(setup: OutboxConsumerModuleSetup): DynamicModule {
    const validated = validateOptions(setup);

    const providers: Provider[] = [
      { provide: OUTBOX_CONSUMER_OPTIONS_TOKEN, useValue: validated },
      {
        provide: OUTBOX_CONSUMER_REDIS_TOKEN,
        useFactory: setup.redis.useFactory,
        ...(setup.redis.inject !== undefined && { inject: setup.redis.inject }),
      },
      {
        provide: OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
        useFactory: setup.dedupStore.useFactory,
        ...(setup.dedupStore.inject !== undefined && {
          inject: setup.dedupStore.inject,
        }),
      },
      OutboxConsumerService,
      OutboxConsumerScheduler,
    ];

    return {
      module: OutboxConsumerModule,
      ...(setup.imports !== undefined && { imports: setup.imports }),
      providers,
      exports: [
        OutboxConsumerService,
        OutboxConsumerScheduler,
        OUTBOX_CONSUMER_OPTIONS_TOKEN,
        // Exported so consumers can inject the same instances the SDK
        // uses. `worker-search-indexer`'s readiness probe injects the
        // Redis client for exactly this reason — and could not resolve
        // it once the providers moved here, because a provider declared
        // by a module is visible to that module alone until exported
        // (TS-506). Both are exported rather than just the client: a
        // rule about which of the SDK's two dependencies is inspectable
        // would be arbitrary.
        OUTBOX_CONSUMER_REDIS_TOKEN,
        OUTBOX_CONSUMER_DEDUP_STORE_TOKEN,
      ],
    };
  }
}
