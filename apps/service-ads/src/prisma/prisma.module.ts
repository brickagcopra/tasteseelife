import { Global, Module } from '@nestjs/common';
import {
  TENANT_CONTEXT_OPTIONS_TOKEN,
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  type ValidatedOptions,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { PrismaService, wrapWithTenantScope } from './prisma.service';

/**
 * PrismaService is provided via a factory so the tenant-scope Prisma
 * extension (TS-141) is applied to the DI-resolved instance. The factory:
 *
 *   1. Constructs a bare `PrismaService` (`extends PrismaClient`) with
 *      the default Prisma config sourced from `DATABASE_URL`.
 *   2. Wraps it with `wrapWithTenantScope`, which applies the extension
 *      via `$extends` and returns a `Proxy<PrismaService>` whose
 *      property reads route every model + raw-SQL operation through the
 *      extended client — so the tenant-scope gate fires on every query
 *      (CLAUDE.md §3.2 + §17.10).
 *   3. Returns the proxy as the DI-resolved `PrismaService` token. Every
 *      consumer that injects `PrismaService` gets the wrapped instance.
 *
 * The wrapper preserves `PrismaService`'s shape, so
 * `this.prisma.adCampaign`, `this.prisma.$transaction`, `this.prisma.ping`
 * etc. all continue to work without changes at the callsite. The lifecycle
 * methods (`onModuleInit` / `onModuleDestroy`) run on the base client, not
 * the extended one, so `$connect` / `$disconnect` operate on the underlying
 * connection pool directly.
 *
 * `TenantContextModule.forRoot(...)` in `AppModule` provides the
 * `TENANT_CONTEXT_STORE_TOKEN` + `TENANT_CONTEXT_OPTIONS_TOKEN` this
 * factory consumes; the module is `@Global()` so the tokens are
 * available here without re-importing it.
 */
@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: (store: TenantContextStore, options: ValidatedOptions): PrismaService => {
        const base = new PrismaService();
        return wrapWithTenantScope(base, store, options);
      },
      inject: [TENANT_CONTEXT_STORE_TOKEN, TENANT_CONTEXT_OPTIONS_TOKEN],
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
