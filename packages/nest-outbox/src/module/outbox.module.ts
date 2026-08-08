import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';

import { type OutboxModuleOptions, validateOptions } from '../config';
import { OutboxService } from '../service/outbox.service';
import { OUTBOX_OPTIONS_TOKEN } from './tokens';

/**
 * Wires the outbox producer SDK into a Nest application.
 *
 * The module is `@Global()` so consumers don't have to re-import it
 * from every feature module. `OutboxService` is the only public
 * provider — services inject it and call `append(tx, {...})` inside
 * their existing Prisma transaction.
 *
 * @example
 *
 *   ```ts
 *   imports: [
 *     OutboxModule.forRoot({
 *       serviceName: 'service-subscription',
 *       schemaName: 'subscription',
 *     }),
 *   ],
 *   ```
 *
 * Each service ships a Prisma migration that creates the canonical
 * `outbox_events` table in its own schema; the relay
 * (`apps/worker-outbox-relay`) is configured with the list of
 * `{schema}.outbox_events` sources to poll.
 */
@Global()
@Module({})
export class OutboxModule {
  static forRoot(options: OutboxModuleOptions): DynamicModule {
    const validated = validateOptions(options);

    const optionsProvider: Provider = {
      provide: OUTBOX_OPTIONS_TOKEN,
      useValue: validated,
    };

    return {
      module: OutboxModule,
      providers: [optionsProvider, OutboxService],
      exports: [OutboxService, OUTBOX_OPTIONS_TOKEN],
    };
  }
}
