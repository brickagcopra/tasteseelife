import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';

import { PagerDutyClient } from '../client';
import { type PagerDutyModuleOptions, validatePagerDutyOptions } from './options';
import { PAGERDUTY_OPTIONS_TOKEN } from './tokens';

/**
 * Wires the PagerDuty Events API v2 client into a Nest application.
 *
 * The module is `@Global()` so feature modules that page on-call don't need
 * to re-import it — they inject `PagerDutyClient` directly, the same way
 * `service-concierge`'s `EmergencyService` does.
 *
 * Options are validated eagerly at module-definition time (see
 * `validatePagerDutyOptions`): a bad `eventsUrl` or an out-of-range timeout
 * fails the boot, not the page.
 *
 * @example
 *
 *   ```ts
 *   imports: [
 *     PagerDutyModule.forRoot({
 *       source: 'service-concierge',
 *       routingKey: env.PAGERDUTY_ROUTING_KEY,
 *       eventsUrl: env.PAGERDUTY_EVENTS_URL,
 *       timeoutMs: env.PAGERDUTY_TIMEOUT_MS,
 *     }),
 *   ],
 *   ```
 */
@Global()
@Module({})
export class PagerDutyModule {
  static forRoot(options: PagerDutyModuleOptions): DynamicModule {
    const validated = validatePagerDutyOptions(options);

    const optionsProvider: Provider = {
      provide: PAGERDUTY_OPTIONS_TOKEN,
      useValue: validated,
    };

    return {
      module: PagerDutyModule,
      providers: [optionsProvider, PagerDutyClient],
      exports: [PAGERDUTY_OPTIONS_TOKEN, PagerDutyClient],
    };
  }
}
