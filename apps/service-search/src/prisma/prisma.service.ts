import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
// Imported from the service's own generated client (see the `output`
// note in prisma/schema.prisma), NOT from the bare `@prisma/client`
// specifier — that resolves to the shared pnpm store stub, which has no
// models and throws "did not initialize yet" on construction.
import { PrismaClient, type Prisma } from '../../prisma/generated';
import {
  createTenantScopeExtension,
  type ExtensionLogger,
  type TenantContextStore,
  type ValidatedOptions,
} from '@taste-and-see/nest-prisma-tenant-scope';

/**
 * Wraps `PrismaClient` with NestJS lifecycle hooks so the connection
 * pool opens at module init and closes cleanly on shutdown (works in
 * concert with `app.enableShutdownHooks()` in main.ts).
 *
 * `ping()` exposes a single-row read used by the readiness probe — kept
 * cheap enough to run on every `/readyz` poll without distorting
 * Postgres load.
 *
 * Tenant-scoping (CLAUDE.md §3.2 + §17.10;
 * TS-020-followup-2b-platform-rollout-svc-search): the production DI
 * graph wires this service through `PrismaModule`'s factory provider
 * (`wrapWithTenantScope` below), which applies the TS-141 Prisma
 * extension. Every model read/write, every `$transaction` callback, and
 * every raw-SQL operation through the DI-injected `PrismaService` fires
 * the tenant-scope gate.
 *
 * `SearchRankingConfig` is listed as `unscopedModels` in the `AppModule`
 * configuration — the row is platform-wide ops config (region-keyed,
 * not tenant-keyed), so the gate allows operations against it from any
 * authenticated frame OR an `exempt` frame on the shared-secret-pinned
 * internal endpoint. The wrap itself stays in place so the gate sees a
 * consistent surface for every Prisma operation.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }
}

/**
 * The transaction-client shape Prisma passes into `$transaction`
 * callbacks. Re-exported as a type for explicit `(tx: PrismaTransactionClient)`
 * annotations.
 */
export type PrismaTransactionClient = Prisma.TransactionClient;

/**
 * Property names that must NOT be routed through the extended client.
 * Mirrors the canonical service-audit / service-provider pattern.
 */
const BASE_CLIENT_PASSTHROUGH = new Set<PropertyKey>([
  'onModuleInit',
  'onModuleDestroy',
  'ping',
  '$connect',
  '$disconnect',
  '$on',
]);

/**
 * Wrap a `PrismaService` instance with the TS-141 tenant-scope Prisma
 * extension. Returns a `Proxy<PrismaService>` whose property reads
 * route base-vs-extended consistently. Mirrors the canonical service-audit
 * shape one-for-one — see `apps/service-audit/src/prisma/prisma.service.ts`
 * for the full rationale.
 */
export function wrapWithTenantScope(
  base: PrismaService,
  store: TenantContextStore,
  options: ValidatedOptions,
): PrismaService {
  const log = new Logger('PrismaService:tenant-scope');
  const extensionLogger: ExtensionLogger = {
    warn(message, context) {
      log.warn(context !== undefined ? `${message} ${JSON.stringify(context)}` : message);
    },
    debug(message, context) {
      log.debug(context !== undefined ? `${message} ${JSON.stringify(context)}` : message);
    },
  };

  const extended = base.$extends(
    createTenantScopeExtension({
      store,
      options,
      logger: extensionLogger,
    }),
  );
  const extendedBag = extended as unknown as Record<PropertyKey, unknown>;
  const baseBag = base as unknown as Record<PropertyKey, unknown>;

  return new Proxy(base, {
    get(_target, prop): unknown {
      if (BASE_CLIENT_PASSTHROUGH.has(prop)) {
        const value = baseBag[prop];
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(base)
          : value;
      }
      const value = extendedBag[prop];
      if (value === undefined) {
        return baseBag[prop];
      }
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(extended)
        : value;
    },
  }) as PrismaService;
}
