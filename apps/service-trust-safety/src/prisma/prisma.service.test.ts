import { describe, expect, it, vi } from 'vitest';
import {
  TenantContextStore,
  validateOptions,
  type ValidatedOptions,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { type PrismaService, wrapWithTenantScope } from './prisma.service';

/**
 * Unit tests for `wrapWithTenantScope` (TS-141 wiring).
 *
 * The function is the only piece of `prisma.service.ts` with non-trivial
 * runtime behaviour — the class itself is a thin `PrismaClient` wrapper
 * with three Nest lifecycle methods. These unit tests pin the Proxy
 * routing logic: which property reads bind to the base, which bind to
 * the extended client, and how unknown properties fall back. They mirror
 * the canonical shape landed in `service-content` / `service-ads` /
 * `service-concierge`.
 *
 * The tests build a fake "base" PrismaService (`as unknown as
 * PrismaService`) with a stubbed `$extends` so the production wrapper
 * sees a known extended-client object. This keeps the unit suite
 * Prisma-engine-free; the real `$extends` (and the `enforce`-mode
 * `MissingRequestContextError` posture on the `incident` model) is
 * exercised end-to-end when the service boots against a real Postgres in
 * the Testcontainers integration suite (a carried TS-300 followup).
 */

interface FakeExtendedClient {
  readonly incident: { findMany: (this: unknown) => string };
  readonly $transaction: () => string;
  readonly $queryRaw: () => string;
  readonly $connect: () => string;
  readonly $disconnect: () => string;
}

const fakeOptions = (): ValidatedOptions =>
  validateOptions({
    serviceName: 'service-trust-safety-test',
    environment: 'test',
  });

const makeFakeExtended = (overrides: Partial<FakeExtendedClient> = {}): FakeExtendedClient => ({
  incident: {
    findMany(): string {
      return 'EXT_INCIDENT';
    },
  },
  $transaction: (): string => 'EXT_TX',
  $queryRaw: (): string => 'EXT_QR',
  $connect: (): string => 'EXT_CONNECT',
  $disconnect: (): string => 'EXT_DISCONNECT',
  ...overrides,
});

interface FakeBase {
  readonly $extends: (def: unknown) => unknown;
  onModuleInit: () => Promise<void>;
  onModuleDestroy: () => Promise<void>;
  ping: () => Promise<void>;
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
}

const makeFakeBase = (
  fakeExtended: FakeExtendedClient,
  overrides: Partial<FakeBase> = {},
): FakeBase => ({
  $extends: vi.fn().mockReturnValue(fakeExtended),
  onModuleInit: vi.fn().mockResolvedValue(undefined),
  onModuleDestroy: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue(undefined),
  $connect: vi.fn().mockResolvedValue(undefined),
  $disconnect: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

function wrap(base: FakeBase): PrismaService {
  return wrapWithTenantScope(
    base as unknown as PrismaService,
    new TenantContextStore(),
    fakeOptions(),
  );
}

describe('wrapWithTenantScope', () => {
  it('routes model accessors through the extended client (the tenant gate fires on every incident op)', () => {
    const fakeExtended = makeFakeExtended();
    const wrapped = wrap(makeFakeBase(fakeExtended));

    expect((wrapped.incident as unknown as { findMany: () => string }).findMany()).toBe(
      'EXT_INCIDENT',
    );
  });

  it('routes $transaction through the extended client', () => {
    const wrapped = wrap(makeFakeBase(makeFakeExtended()));

    expect((wrapped.$transaction as unknown as () => string)()).toBe('EXT_TX');
  });

  it('routes $queryRaw through the extended client', () => {
    const wrapped = wrap(makeFakeBase(makeFakeExtended()));

    expect((wrapped.$queryRaw as unknown as () => string)()).toBe('EXT_QR');
  });

  it('pins $connect / $disconnect to the base client (extensions deny-list connection lifecycle)', async () => {
    const fakeExtended = makeFakeExtended({
      $connect: (): string => {
        throw new Error('extended $connect must not be invoked');
      },
      $disconnect: (): string => {
        throw new Error('extended $disconnect must not be invoked');
      },
    });
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrap(base);

    await (wrapped.$connect as unknown as () => Promise<void>)();
    await (wrapped.$disconnect as unknown as () => Promise<void>)();
    expect(base.$connect).toHaveBeenCalledTimes(1);
    expect(base.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('pins the Nest lifecycle methods and ping to the base', async () => {
    const base = makeFakeBase(makeFakeExtended());
    const wrapped = wrap(base);

    await wrapped.onModuleInit();
    await wrapped.onModuleDestroy();
    await wrapped.ping();

    expect(base.onModuleInit).toHaveBeenCalledTimes(1);
    expect(base.onModuleDestroy).toHaveBeenCalledTimes(1);
    expect(base.ping).toHaveBeenCalledTimes(1);
  });

  it('preserves the `this` binding of model methods on the natural callsite pattern', () => {
    let observedThis: unknown;
    const fakeExtended = makeFakeExtended({
      incident: {
        findMany(this: unknown): string {
          observedThis = this;
          return 'OK';
        },
      },
    });
    const wrapped = wrap(makeFakeBase(fakeExtended));

    const accessor = wrapped.incident as unknown as { findMany: () => string };
    expect(accessor.findMany()).toBe('OK');
    expect(observedThis).toBe(fakeExtended.incident);
  });
});
