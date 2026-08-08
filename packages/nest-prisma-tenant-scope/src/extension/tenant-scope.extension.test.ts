import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@taste-and-see/auth-sdk';

import { validateOptions, type ValidatedOptions } from '../config';
import { TenantContextStore } from '../context/context-store';
import { runWithoutTenantContext } from '../context/exempt';
import { MissingRequestContextError } from './errors';

// Mock the @prisma/client import. We don't want to spin up a Prisma
// client for unit tests — instead, intercept `Prisma.defineExtension`
// to capture the extension shape and exercise `$allOperations` directly.
type DefinedExtension = {
  name?: string;
  query?: {
    $allOperations?: (args: {
      model: string | undefined;
      operation: string;
      args: unknown;
      query: (args: unknown) => Promise<unknown>;
    }) => Promise<unknown> | unknown;
  };
};

vi.mock('@prisma/client', () => ({
  Prisma: {
    defineExtension: (def: DefinedExtension): DefinedExtension => def,
  },
}));

// Import AFTER the mock so the factory binds to the mocked module.
import { createTenantScopeExtension, type ExtensionLogger } from './tenant-scope.extension';

interface CapturingLogger extends ExtensionLogger {
  readonly warnCalls: Array<{ message: string; context?: Record<string, unknown> }>;
  readonly debugCalls: Array<{ message: string; context?: Record<string, unknown> }>;
}

const makeLogger = (): CapturingLogger => {
  const warnCalls: CapturingLogger['warnCalls'] = [];
  const debugCalls: CapturingLogger['debugCalls'] = [];
  return {
    warnCalls,
    debugCalls,
    warn(message, context) {
      warnCalls.push(context === undefined ? { message } : { message, context });
    },
    debug(message, context) {
      debugCalls.push(context === undefined ? { message } : { message, context });
    },
  };
};

const baseOptions = (
  override: Partial<Parameters<typeof validateOptions>[0]> = {},
): ValidatedOptions =>
  validateOptions({
    serviceName: 'service-test',
    environment: 'test',
    ...override,
  });

const sampleContext = (): RequestContext => ({
  userId: 'usr_1',
  mfaVerified: true,
  roles: [],
  tenantScope: { type: 'global' },
});

/**
 * Invokes the extension's `$allOperations` hook directly.
 * Returns whatever the hook returns (a value or a thrown error).
 */
const invokeExtension = async (
  ext: DefinedExtension,
  args: {
    model: string | undefined;
    operation: string;
    onQuery?: (a: unknown) => Promise<unknown> | unknown;
  },
): Promise<unknown> => {
  const allOps = ext.query?.$allOperations;
  if (!allOps) throw new Error('extension did not declare $allOperations');
  return allOps({
    model: args.model,
    operation: args.operation,
    args: { where: { id: 'x' } },
    query: (a) => Promise.resolve(args.onQuery ? args.onQuery(a) : { ok: true }),
  });
};

describe('createTenantScopeExtension', () => {
  let store: TenantContextStore;
  let logger: CapturingLogger;

  beforeEach(() => {
    store = new TenantContextStore();
    logger = makeLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exposes the package name on the extension', () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions(),
      logger,
    }) as DefinedExtension;
    expect(ext.name).toBe('@taste-and-see/nest-prisma-tenant-scope');
  });

  it('runs the underlying query when a scoped frame is in scope', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions(),
      logger,
    }) as DefinedExtension;

    const result = await store.runWith(sampleContext(), () =>
      invokeExtension(ext, { model: 'Booking', operation: 'findMany' }),
    );

    expect(result).toEqual({ ok: true });
    expect(logger.warnCalls).toHaveLength(0);
  });

  it('runs the underlying query inside an exempt frame and logs at debug', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions(),
      logger,
    }) as DefinedExtension;

    const result = await runWithoutTenantContext(store, 'background-job', () =>
      invokeExtension(ext, { model: 'Booking', operation: 'findMany' }),
    );

    expect(result).toEqual({ ok: true });
    expect(logger.warnCalls).toHaveLength(0);
    expect(logger.debugCalls).toHaveLength(1);
    expect(logger.debugCalls[0]?.context).toMatchObject({
      reason: 'background-job',
      model: 'Booking',
      operation: 'findMany',
    });
  });

  it('emits a single warn line and proceeds in audit mode when no frame is in scope', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({ enforcement: 'audit' }),
      logger,
    }) as DefinedExtension;

    const result = await invokeExtension(ext, { model: 'Booking', operation: 'findMany' });

    expect(result).toEqual({ ok: true });
    expect(logger.warnCalls).toHaveLength(1);
    expect(logger.warnCalls[0]?.context).toMatchObject({
      service: 'service-test',
      env: 'test',
      model: 'Booking',
      operation: 'findMany',
      enforcement: 'audit',
    });
  });

  it('throws MissingRequestContextError in enforce mode when no frame is in scope', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({ enforcement: 'enforce' }),
      logger,
    }) as DefinedExtension;

    await expect(
      invokeExtension(ext, { model: 'Booking', operation: 'findMany' }),
    ).rejects.toBeInstanceOf(MissingRequestContextError);
  });

  it('captures the model + operation on the thrown error metadata', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({ enforcement: 'enforce' }),
      logger,
    }) as DefinedExtension;

    try {
      await invokeExtension(ext, { model: 'Provider', operation: 'update' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingRequestContextError);
      const e = err as MissingRequestContextError;
      expect(e.serviceName).toBe('service-test');
      expect(e.model).toBe('Provider');
      expect(e.operation).toBe('update');
      expect(e.internalCode).toBe('TENANT_SCOPE_MISSING_CONTEXT');
    }
  });

  it('allows raw $queryRaw without a frame regardless of enforcement', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({ enforcement: 'enforce' }),
      logger,
    }) as DefinedExtension;

    const result = await invokeExtension(ext, {
      model: undefined,
      operation: '$queryRaw',
    });

    expect(result).toEqual({ ok: true });
    expect(logger.warnCalls).toHaveLength(0);
  });

  it('allows operations on an unscoped model without a frame', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({ enforcement: 'enforce', unscopedModels: ['Plan'] }),
      logger,
    }) as DefinedExtension;

    const result = await invokeExtension(ext, { model: 'Plan', operation: 'findMany' });
    expect(result).toEqual({ ok: true });
    expect(logger.warnCalls).toHaveLength(0);
  });

  it('still gates a scoped model when an unrelated unscoped model is configured', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({ enforcement: 'enforce', unscopedModels: ['Plan'] }),
      logger,
    }) as DefinedExtension;

    await expect(
      invokeExtension(ext, { model: 'Booking', operation: 'findMany' }),
    ).rejects.toBeInstanceOf(MissingRequestContextError);
  });

  it('propagates the value returned by the inner Prisma query through the extension', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions(),
      logger,
    }) as DefinedExtension;

    const expected = { id: 'bkg_1' };
    const result = await store.runWith(sampleContext(), () =>
      invokeExtension(ext, {
        model: 'Booking',
        operation: 'findUnique',
        onQuery: () => expected,
      }),
    );
    expect(result).toBe(expected);
  });

  it('propagates the rejection from the inner Prisma query unchanged', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions(),
      logger,
    }) as DefinedExtension;

    const boom = new Error('connection lost');
    await expect(
      store.runWith(sampleContext(), () =>
        invokeExtension(ext, {
          model: 'Booking',
          operation: 'findMany',
          onQuery: () => Promise.reject(boom),
        }),
      ),
    ).rejects.toBe(boom);
  });

  it('handles an unscoped operation override that drops $queryRaw from the allow-list', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({
        enforcement: 'enforce',
        unscopedOperations: [],
      }),
      logger,
    }) as DefinedExtension;

    await expect(
      invokeExtension(ext, { model: undefined, operation: '$queryRaw' }),
    ).rejects.toBeInstanceOf(MissingRequestContextError);
  });

  it('emits no warn line for an unscoped model in audit mode', async () => {
    const ext = createTenantScopeExtension({
      store,
      options: baseOptions({ unscopedModels: ['Plan'] }),
      logger,
    }) as DefinedExtension;

    await invokeExtension(ext, { model: 'Plan', operation: 'findMany' });
    expect(logger.warnCalls).toHaveLength(0);
  });

  it('treats a missing logger.debug gracefully', async () => {
    // Build a logger that intentionally omits .debug.
    const slimLogger: ExtensionLogger = {
      warn: (msg: string, ctx?: Record<string, unknown>) => {
        logger.warnCalls.push(
          ctx === undefined ? { message: msg } : { message: msg, context: ctx },
        );
      },
    };

    const ext = createTenantScopeExtension({
      store,
      options: baseOptions(),
      logger: slimLogger,
    }) as DefinedExtension;

    const result = await runWithoutTenantContext(store, 'job', () =>
      invokeExtension(ext, { model: 'Booking', operation: 'findMany' }),
    );
    expect(result).toEqual({ ok: true });
  });
});
