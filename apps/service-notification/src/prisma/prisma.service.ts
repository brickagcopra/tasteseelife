import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
// Imported from the service's own generated client (see the `output`
// note in prisma/schema.prisma), NOT from the bare `@prisma/client`
// specifier — that resolves to the shared pnpm store stub, which has no
// models and throws "did not initialize yet" on construction.
import { Prisma, PrismaClient } from '../../prisma/generated';
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
 * Tenant-scoping (CLAUDE.md §3.2 + §17.10; TS-020-followup-2b-platform-rollout):
 * the production DI graph wires this service through `PrismaModule`'s
 * factory provider (`wrapWithTenantScope` below), which applies the
 * TS-141 Prisma extension. Every model read/write, every `$transaction`
 * callback, and every raw-SQL operation through the DI-injected
 * `PrismaService` fires the tenant-scope gate. Direct instantiation
 * (`new PrismaService(...)`) — used by integration-test setup —
 * bypasses the wrapper deliberately; those callers own their own scope
 * discipline. service-notification's Phase-1 row-level access model is
 * "any admin with `notification:write` can author templates"; per-tenant
 * template overrides (per partner brand) land with TS-400.
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
 * callbacks. Re-exported as a type for explicit
 * `(tx: PrismaTransactionClient)` annotations — the version-create
 * path runs inside `$transaction` (lookup-MAX + INSERT new version +
 * optional activation flip) so the explicit annotation makes the
 * no-cross-service-imports invariant (CLAUDE.md §2.3) easy to spot at
 * the call site.
 */
export type PrismaTransactionClient = Prisma.TransactionClient;

/**
 * Property names that must NOT be routed through the extended client.
 * Two reasons a property lands here:
 *
 *   - It is a `PrismaService` instance method (`onModuleInit`,
 *     `onModuleDestroy`, `ping`) defined on the base — invoking these
 *     through the extension wrapper would either no-op (they aren't
 *     intercepted by `$allOperations`) or route through the extended
 *     client's own copy when only the base's copy exists. Cleaner to
 *     pin them to the base.
 *
 *   - It is a Prisma connection-lifecycle method (`$connect`,
 *     `$disconnect`, `$on`). The Prisma extension's `$allOperations`
 *     does NOT intercept these — Prisma's denylist for extensions
 *     excludes them — but routing them through the extended client
 *     can produce subtle proxy-this binding issues. Pinning to the
 *     base sidesteps that risk.
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
 * route as follows:
 *
 *   - `BASE_CLIENT_PASSTHROUGH` members → base client (lifecycle +
 *     `$connect`/`$disconnect`/`$on`). Bound to the base so `this`
 *     inside a method body refers to the unwrapped instance.
 *
 *   - everything else → extended client. Model accessors
 *     (`notificationTemplate`, `notificationTemplateVersion`,
 *     `notificationPreference`, `notificationDispatch`, ...) and
 *     `$transaction` / `$queryRaw` / `$executeRaw` route here so the
 *     extension's `$allOperations` hook fires on every operation.
 *
 * Callsites do not change: `this.prisma.notificationTemplate.findMany()`
 * still has the same type and the same behaviour, but the query now
 * flows through the tenant-scope gate. `this.prisma.$transaction(async
 * (tx) => ...)` yields a `tx` that is the extended client's transaction
 * client, so each model access inside the transaction also fires the gate.
 *
 * Why a Proxy instead of replacing the class? `PrismaClient.$extends`
 * returns an extended-client type with a complex generic signature
 * that would otherwise leak through every DI-typed boundary. Keeping
 * `PrismaService extends PrismaClient` preserves the simple type while
 * the runtime delegates property access through the extended client.
 */
export function wrapWithTenantScope(
  base: PrismaService,
  store: TenantContextStore,
  options: ValidatedOptions,
): PrismaService {
  const log = new Logger('PrismaService:tenant-scope');
  const extensionLogger: ExtensionLogger = {
    warn(message, context) {
      // Nest's Logger accepts (message, ...optionalParams); we serialise the
      // structured context inline so it lands in the standard log line.
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
  // Treat the extended client as a property-bag for the Proxy — the
  // specific extended-client generic is service-local and not what
  // callsites consume; they see the underlying PrismaService shape.
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
