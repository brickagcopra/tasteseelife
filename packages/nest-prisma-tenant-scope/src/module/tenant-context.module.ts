import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { type TenantContextModuleOptions, validateOptions } from '../config';
import { TenantContextStore } from '../context/context-store';
import { TenantContextInterceptor } from '../interceptor/tenant-context.interceptor';
import { TENANT_CONTEXT_OPTIONS_TOKEN, TENANT_CONTEXT_STORE_TOKEN } from './tokens';

/**
 * Wires the tenant-scoping SDK into a Nest application.
 *
 * The module is `@Global()` so consumers don't have to re-import it
 * from every feature module. Providers exposed:
 *
 *   - `TENANT_CONTEXT_STORE_TOKEN`   → the singleton `TenantContextStore`
 *   - `TENANT_CONTEXT_OPTIONS_TOKEN` → the validated `ValidatedOptions`
 *
 * And `APP_INTERCEPTOR` registers `TenantContextInterceptor` globally so
 * every HTTP request seeds the store on the way in.
 *
 * The Prisma extension itself is NOT registered here — services wire it
 * onto their `PrismaClient` instance directly:
 *
 *   ```ts
 *   const base = new PrismaClient();
 *   const scoped = base.$extends(
 *     createTenantScopeExtension({
 *       store: this.store,
 *       options: this.options,
 *       logger: this.logger,
 *     }),
 *   );
 *   ```
 *
 * The reason is that Prisma extensions return an extended-client type
 * (`Prisma.PrismaClient<...>` becomes a complex generic) which would
 * leak through any abstract DI shape. Letting the consuming
 * `PrismaModule` apply the extension keeps the typed boundary
 * service-local.
 *
 * @example
 *
 *   ```ts
 *   imports: [
 *     TenantContextModule.forRoot({
 *       serviceName: 'service-booking',
 *       environment: env.ENVIRONMENT,
 *       enforcement: 'audit',          // ramp to 'enforce' per CLAUDE.md §3.2
 *       unscopedModels: ['Plan'],      // catalog tables
 *     }),
 *   ],
 *   ```
 */
@Global()
@Module({})
export class TenantContextModule {
  static forRoot(options: TenantContextModuleOptions): DynamicModule {
    const validated = validateOptions(options);

    const optionsProvider: Provider = {
      provide: TENANT_CONTEXT_OPTIONS_TOKEN,
      useValue: validated,
    };

    const storeProvider: Provider = {
      provide: TENANT_CONTEXT_STORE_TOKEN,
      useValue: new TenantContextStore(),
    };

    const interceptorProvider: Provider = {
      provide: APP_INTERCEPTOR,
      useClass: TenantContextInterceptor,
    };

    return {
      module: TenantContextModule,
      providers: [optionsProvider, storeProvider, interceptorProvider],
      exports: [TENANT_CONTEXT_STORE_TOKEN, TENANT_CONTEXT_OPTIONS_TOKEN],
    };
  }
}
