import { Prisma } from '@prisma/client';

import type { TenantContextStore } from '../context/context-store';
import type { ValidatedOptions } from '../config';
import { MissingRequestContextError } from './errors';
import { evaluateGate, toReadonlySet } from './gate';

/**
 * The slim subset of NestJS' `Logger` the extension needs. Decoupling
 * from `@nestjs/common` here means the pure extension can be unit-tested
 * with an in-memory fake without importing the Nest container.
 */
export interface ExtensionLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  debug?(message: string, context?: Record<string, unknown>): void;
}

/**
 * Factory options. The extension wants the singleton-per-app
 * `TenantContextStore` (from `TENANT_CONTEXT_STORE_TOKEN`) + the
 * validated config + a logger. Consumers pass these in explicitly so
 * the extension can compose with any DI shape.
 */
export interface CreateExtensionOptions {
  readonly store: TenantContextStore;
  readonly options: ValidatedOptions;
  readonly logger: ExtensionLogger;
}

/**
 * Builds a Prisma client extension that intercepts every operation and
 * enforces the tenant-scoping gate (CLAUDE.md §3.2 + §17.10).
 *
 * Usage:
 *
 *   ```ts
 *   const base = new PrismaClient();
 *   const scoped = base.$extends(createTenantScopeExtension({
 *     store, options, logger,
 *   }));
 *   ```
 *
 * The extension wraps `$allOperations` — Prisma's universal interceptor
 * surface. For each operation:
 *
 *   1. Compute the gate decision via `evaluateGate` (pure).
 *   2. Branch on the decision:
 *      - `proceed_scoped`              → run the query (row-level
 *                                        filters will read the frame
 *                                        when wired up per service).
 *      - `proceed_exempt`              → run + audit-log at debug level
 *                                        in `audit` mode, silent in
 *                                        `enforce` mode (exempt scopes
 *                                        are deliberate; spam is noise).
 *      - `proceed_unscoped_model`      → run silently.
 *      - `proceed_unscoped_operation`  → run silently.
 *      - `proceed_with_warning`        → emit a structured WARN log
 *                                        with the model + operation +
 *                                        a synthetic stack frame, then
 *                                        run. Phase-1 ramp signal.
 *      - `block`                        → throw `MissingRequestContextError`
 *                                        BEFORE the query touches Postgres.
 *
 * `$allOperations` is the Prisma 5.x replacement for the deprecated
 * `$use` middleware. It runs at the lowest layer of the client, so
 * `$transaction` callbacks are intercepted too (the same async-local
 * frame the interceptor seeded carries through transaction work).
 */
export function createTenantScopeExtension({
  store,
  options,
  logger,
}: CreateExtensionOptions): ReturnType<typeof Prisma.defineExtension> {
  const unscopedModels = toReadonlySet(options.unscopedModels);
  const unscopedOperations = toReadonlySet(options.unscopedOperations);

  return Prisma.defineExtension({
    name: '@taste-and-see/nest-prisma-tenant-scope',
    query: {
      $allOperations({ model, operation, args, query }) {
        const decision = evaluateGate({
          frame: store.current(),
          model,
          operation,
          enforcement: options.enforcement,
          unscopedModels,
          unscopedOperations,
        });

        switch (decision.outcome) {
          case 'proceed_scoped':
          case 'proceed_unscoped_model':
          case 'proceed_unscoped_operation':
            return query(args);

          case 'proceed_exempt':
            // Debug-level — exempt scopes are deliberate so a warn would
            // be noise. The reason is on the frame for any audit reader
            // that does want to surface it (e.g. a metrics aggregator).
            if (typeof logger.debug === 'function') {
              logger.debug('tenant-scope: exempt scope', {
                service: options.serviceName,
                env: options.environment,
                model,
                operation,
                reason: decision.reason,
              });
            }
            return query(args);

          case 'proceed_with_warning':
            logger.warn('tenant-scope: query without RequestContext', {
              service: options.serviceName,
              env: options.environment,
              model,
              operation,
              enforcement: options.enforcement,
              hint: 'wrap in TenantContextStore.runWith(ctx, ...) or runWithoutTenantContext(reason, ...)',
            });
            return query(args);

          case 'block':
            throw new MissingRequestContextError(options.serviceName, model, operation);
        }
      },
    },
  });
}
