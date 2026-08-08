import { describe, expect, it } from 'vitest';

import { TenantContextStore } from './context-store';
import { RUN_WITHOUT_TENANT_CONTEXT_MAX_REASON_LENGTH, runWithoutTenantContext } from './exempt';

describe('runWithoutTenantContext', () => {
  it('sets an exempt frame inside the callback', () => {
    const store = new TenantContextStore();
    runWithoutTenantContext(store, 'seed', () => {
      const frame = store.current();
      expect(frame?.kind).toBe('exempt');
      if (frame?.kind === 'exempt') expect(frame.reason).toBe('seed');
    });
    expect(store.current()).toBeNull();
  });

  it('returns the value produced by the callback', () => {
    const store = new TenantContextStore();
    const value = runWithoutTenantContext(store, 'seed', () => 42);
    expect(value).toBe(42);
  });

  it('returns the awaited promise from an async callback', async () => {
    const store = new TenantContextStore();
    const value = await runWithoutTenantContext(store, 'seed', async () => {
      await Promise.resolve();
      return store.current()?.kind;
    });
    expect(value).toBe('exempt');
  });

  it('throws on empty reason', () => {
    const store = new TenantContextStore();
    expect(() => runWithoutTenantContext(store, '', () => undefined)).toThrow(RangeError);
  });

  it('throws on a reason over the cap', () => {
    const store = new TenantContextStore();
    const big = 'x'.repeat(RUN_WITHOUT_TENANT_CONTEXT_MAX_REASON_LENGTH + 1);
    expect(() => runWithoutTenantContext(store, big, () => undefined)).toThrow(RangeError);
  });

  it('throws on a non-string reason', () => {
    const store = new TenantContextStore();
    expect(() => runWithoutTenantContext(store, 0 as unknown as string, () => undefined)).toThrow(
      RangeError,
    );
  });

  it('accepts a reason at the exact length cap', () => {
    const store = new TenantContextStore();
    const reason = 'x'.repeat(RUN_WITHOUT_TENANT_CONTEXT_MAX_REASON_LENGTH);
    runWithoutTenantContext(store, reason, () => {
      const frame = store.current();
      if (frame?.kind === 'exempt') expect(frame.reason.length).toBe(reason.length);
    });
  });

  it('nests inside an outer scoped frame and masks it for the duration', () => {
    const store = new TenantContextStore();
    store.runWith(
      {
        userId: 'usr_x',
        mfaVerified: true,
        roles: [],
        tenantScope: { type: 'global' },
      },
      () => {
        expect(store.current()?.kind).toBe('scoped');
        runWithoutTenantContext(store, 'inner-job', () => {
          expect(store.current()?.kind).toBe('exempt');
        });
        // Outer scoped frame restored after the exempt nesting exits.
        expect(store.current()?.kind).toBe('scoped');
      },
    );
  });
});
