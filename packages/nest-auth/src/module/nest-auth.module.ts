import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';

import { AccessTokenGuard } from '../access-token-guard';
import { PermissionGuard } from '../permission-guard';
import { type NestAuthModuleOptions, validateNestAuthOptions } from './options';
import { JWT_VERIFIER_OPTIONS_TOKEN } from './tokens';

/**
 * Wires `@taste-and-see/nest-auth` into a Nest application.
 *
 * The module is `@Global()` so consumer feature modules don't need to
 * re-import it; controllers apply guards with
 * `@UseGuards(AccessTokenGuard)` (or `@UseGuards(AccessTokenGuard,
 * PermissionGuard)` for RBAC-gated routes).
 *
 * @example
 *
 *   ```ts
 *   import { NestAuthModule } from '@taste-and-see/nest-auth';
 *
 *   @Module({
 *     imports: [
 *       NestAuthModule.forRoot({
 *         jwtAccessSecret: env.JWT_ACCESS_SECRET,
 *         jwtIssuer: env.JWT_ISSUER,
 *         jwtAudience: env.JWT_AUDIENCE,
 *       }),
 *     ],
 *   })
 *   export class AppModule {}
 *   ```
 *
 * @example Per-controller usage:
 *
 *   ```ts
 *   import { AccessTokenGuard, PermissionGuard, RequirePermissions } from '@taste-and-see/nest-auth';
 *
 *   @UseGuards(AccessTokenGuard, PermissionGuard)
 *   @Controller('api/v1/admin/providers')
 *   export class AdminProvidersController {
 *     @RequirePermissions('provider:approve')
 *     @Post(':id/tier/evaluate')
 *     evaluate() {}
 *   }
 *   ```
 */
@Global()
@Module({})
export class NestAuthModule {
  static forRoot(options: NestAuthModuleOptions): DynamicModule {
    const validated = validateNestAuthOptions(options);

    const optionsProvider: Provider = {
      provide: JWT_VERIFIER_OPTIONS_TOKEN,
      useValue: validated,
    };

    return {
      module: NestAuthModule,
      providers: [optionsProvider, AccessTokenGuard, PermissionGuard],
      exports: [JWT_VERIFIER_OPTIONS_TOKEN, AccessTokenGuard, PermissionGuard],
    };
  }
}
