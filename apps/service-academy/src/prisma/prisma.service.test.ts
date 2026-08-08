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
 * the canonical shape landed in `service-concierge` / `service-household`.
 *
 * The tests build a fake "base" PrismaService (`as unknown as
 * PrismaService`) with a stubbed `$extends` so the production wrapper
 * sees a known extended-client object. This keeps the unit suite
 * Prisma-engine-free; the real `$extends` is exercised end-to-end when
 * the service boots against a real Postgres in a future integration
 * test.
 */

interface FakeExtendedClient {
  readonly academyCourse: { findMany: (this: unknown) => string };
  readonly $transaction: () => string;
  readonly $queryRaw: () => string;
  readonly $connect: () => string;
  readonly $disconnect: () => string;
  readonly customExtensionOnly: string;
}

interface FakeBase {
  readonly $extends: (def: unknown) => unknown;
  onModuleInit: () => Promise<void>;
  onModuleDestroy: () => Promise<void>;
  ping: () => Promise<void>;
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $queryRaw: (...args: unknown[]) => Promise<unknown>;
}

const fakeOptions = (
  overrides: Partial<Parameters<typeof validateOptions>[0]> = {},
): ValidatedOptions =>
  validateOptions({
    serviceName: 'service-academy-test',
    environment: 'test',
    ...overrides,
  });

const makeFakeExtended = (overrides: Partial<FakeExtendedClient> = {}): FakeExtendedClient => ({
  academyCourse: {
    findMany(): string {
      return 'EXT_COURSE';
    },
  },
  $transaction: (): string => 'EXT_TX',
  $queryRaw: (): string => 'EXT_QR',
  $connect: (): string => 'EXT_CONNECT',
  $disconnect: (): string => 'EXT_DISCONNECT',
  customExtensionOnly: 'extension-only-value',
  ...overrides,
});

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
  $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
  ...overrides,
});

describe('wrapWithTenantScope', () => {
  it('routes model accessors through the extended client', () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    expect((wrapped.academyCourse as unknown as { findMany: () => string }).findMany()).toBe(
      'EXT_COURSE',
    );
  });

  it('routes $transaction through the extended client', () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    expect((wrapped.$transaction as unknown as () => string)()).toBe('EXT_TX');
  });

  it('routes $queryRaw through the extended client (raw SQL is intercepted as proceed_unscoped_operation)', () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    expect((wrapped.$queryRaw as unknown as () => string)()).toBe('EXT_QR');
  });

  it('pins $connect to the base client (Prisma extensions deny-list connection lifecycle)', async () => {
    const fakeExtended = makeFakeExtended({
      $connect: (): string => {
        throw new Error('extended $connect must not be invoked');
      },
    });
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    await (wrapped.$connect as unknown as () => Promise<void>)();
    expect(base.$connect).toHaveBeenCalledTimes(1);
  });

  it('pins $disconnect to the base client', async () => {
    const fakeExtended = makeFakeExtended({
      $disconnect: (): string => {
        throw new Error('extended $disconnect must not be invoked');
      },
    });
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    await (wrapped.$disconnect as unknown as () => Promise<void>)();
    expect(base.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('pins onModuleInit to the base', async () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    await wrapped.onModuleInit();
    expect(base.onModuleInit).toHaveBeenCalledTimes(1);
  });

  it('pins onModuleDestroy to the base', async () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    await wrapped.onModuleDestroy();
    expect(base.onModuleDestroy).toHaveBeenCalledTimes(1);
  });

  it('pins ping to the base', async () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    await wrapped.ping();
    expect(base.ping).toHaveBeenCalledTimes(1);
  });

  it('preserves the `this` binding of model methods when called via the natural callsite pattern', () => {
    let observedThis: unknown;
    const fakeExtended = makeFakeExtended({
      academyCourse: {
        findMany(this: unknown): string {
          observedThis = this;
          return 'OK';
        },
      },
    });
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    // The natural Prisma callsite is `this.prisma.academyCourse.findMany(...)`,
    // i.e. method-call syntax on the model accessor. JavaScript binds
    // `this` to the model accessor object on that path — the wrapper
    // doesn't need to do anything special.
    const courseAccessor = wrapped.academyCourse as unknown as { findMany: () => string };
    expect(courseAccessor.findMany()).toBe('OK');
    expect(observedThis).toBe(fakeExtended.academyCourse);
  });

  it('binds top-level $-methods to the extended client so callsite extraction is safe', () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    const tx = wrapped.$transaction as unknown as () => string;
    expect(tx()).toBe('EXT_TX');
  });

  it('falls back to the base when a property exists on neither the extended client nor on a known mapping', () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    (base as unknown as Record<string, unknown>)['__BASE_ONLY__'] = 'base-only-value';
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    expect((wrapped as unknown as Record<string, unknown>)['__BASE_ONLY__']).toBe(
      'base-only-value',
    );
  });

  it('exposes properties added by the extension when they only exist on the extended client', () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);
    const wrapped = wrapWithTenantScope(
      base as unknown as PrismaService,
      new TenantContextStore(),
      fakeOptions(),
    );

    expect((wrapped as unknown as Record<string, unknown>)['customExtensionOnly']).toBe(
      'extension-only-value',
    );
  });

  it('invokes the base $extends exactly once during the wrap, passing the extension definition', () => {
    const fakeExtended = makeFakeExtended();
    const base = makeFakeBase(fakeExtended);

    wrapWithTenantScope(base as unknown as PrismaService, new TenantContextStore(), fakeOptions());

    expect(base.$extends).toHaveBeenCalledTimes(1);
  });
});
