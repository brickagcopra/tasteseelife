import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';

import { TrustHeaderGuard } from '../guard';
import { type TrustHeaderModuleOptions, validateTrustHeaderOptions } from './options';
import { TRUST_HEADER_OPTIONS_TOKEN } from './tokens';

/**
 * Wires the trust-header guard into a Nest application.
 *
 * The module is `@Global()` so consumer feature modules don't need
 * to re-import it; controllers apply the guard with
 * `@UseGuards(TrustHeaderGuard)` (or via `APP_GUARD` when the entire
 * service is gateway-only — caller's choice).
 *
 * @example
 *
 *   ```ts
 *   imports: [
 *     TrustHeaderGuardModule.forRoot({
 *       signingSecret: env.INTERNAL_TRUST_SIGNING_SECRET,
 *       maxAgeSeconds: env.INTERNAL_TRUST_MAX_AGE_SECONDS,
 *     }),
 *   ],
 *   ```
 *
 * @example Per-controller usage:
 *
 *   ```ts
 *   @UseGuards(TrustHeaderGuard)
 *   @Controller('api/v1/plans')
 *   export class PlansController {}
 *   ```
 */
@Global()
@Module({})
export class TrustHeaderGuardModule {
  static forRoot(options: TrustHeaderModuleOptions): DynamicModule {
    const validated = validateTrustHeaderOptions(options);

    const optionsProvider: Provider = {
      provide: TRUST_HEADER_OPTIONS_TOKEN,
      useValue: validated,
    };

    return {
      module: TrustHeaderGuardModule,
      providers: [optionsProvider, TrustHeaderGuard],
      exports: [TRUST_HEADER_OPTIONS_TOKEN, TrustHeaderGuard],
    };
  }
}
