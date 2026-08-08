import { describe, expect, it } from 'vitest';
import type { RequestContext } from '@taste-and-see/auth-sdk';

import { TenantContextStore } from './context-store';

const sampleContext = (): RequestContext => ({
  userId: 'usr_abc',
  mfaVerified: true,
  roles: [],
  tenantScope: { type: 'global' },
});

describe('TenantContextStore', () => {
  it('returns null outside any frame', () => {
    const store = new TenantContextStore();
    expect(store.current()).toBeNull();
  });

  it('returns the active frame inside run()', () => {
    const store = new TenantContextStore();
    const ctx = sampleContext();

    store.run({ kind: 'scoped', context: ctx }, () => {
      const frame = store.current();
      expect(frame?.kind).toBe('scoped');
      if (frame?.kind === 'scoped') {
        expect(frame.context).toBe(ctx);
      }
    });
    expect(store.current()).toBeNull();
  });

  it('runWith wraps run() with a scoped frame', () => {
    const store = new TenantContextStore();
    const ctx = sampleContext();
    let observed: RequestContext | null = null;

    store.runWith(ctx, () => {
      const frame = store.current();
      if (frame?.kind === 'scoped') observed = frame.context;
    });

    expect(observed).toBe(ctx);
  });

  it('returns the value produced by the callback', () => {
    const store = new TenantContextStore();
    const ctx = sampleContext();
    const value = store.runWith(ctx, () => 42);
    expect(value).toBe(42);
  });

  it('returns the resolved promise produced by an async callback', async () => {
    const store = new TenantContextStore();
    const ctx = sampleContext();
    const value = await store.runWith(ctx, async () => {
      await Promise.resolve();
      return store.current()?.kind === 'scoped' ? 'inside' : 'outside';
    });
    expect(value).toBe('inside');
  });

  it('preserves frame across awaits inside the callback', async () => {
    const store = new TenantContextStore();
    const ctx = sampleContext();

    await store.runWith(ctx, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.current()?.kind).toBe('scoped');
    });
  });

  it('nests frames LIFO — the inner frame masks the outer', () => {
    const store = new TenantContextStore();
    const outer = sampleContext();
    const inner: RequestContext = { ...outer, userId: 'usr_inner' };

    store.runWith(outer, () => {
      store.runWith(inner, () => {
        const f = store.current();
        if (f?.kind === 'scoped') expect(f.context.userId).toBe('usr_inner');
      });
      // After the inner frame exits, the outer frame is observed again.
      const f = store.current();
      if (f?.kind === 'scoped') expect(f.context.userId).toBe('usr_abc');
    });
  });

  it('supports an exempt frame', () => {
    const store = new TenantContextStore();
    store.run({ kind: 'exempt', reason: 'background-worker' }, () => {
      const f = store.current();
      expect(f?.kind).toBe('exempt');
      if (f?.kind === 'exempt') expect(f.reason).toBe('background-worker');
    });
  });

  it('isolates concurrent frames across parallel async branches', async () => {
    const store = new TenantContextStore();
    const ctxA: RequestContext = { ...sampleContext(), userId: 'usr_a' };
    const ctxB: RequestContext = { ...sampleContext(), userId: 'usr_b' };

    const [a, b] = await Promise.all([
      store.runWith(ctxA, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        const f = store.current();
        return f?.kind === 'scoped' ? f.context.userId : null;
      }),
      store.runWith(ctxB, async () => {
        await new Promise((resolve) => setImmediate(resolve));
        const f = store.current();
        return f?.kind === 'scoped' ? f.context.userId : null;
      }),
    ]);

    expect(a).toBe('usr_a');
    expect(b).toBe('usr_b');
  });

  it('exposes independent state per store instance', () => {
    const a = new TenantContextStore();
    const b = new TenantContextStore();
    const ctx = sampleContext();

    a.runWith(ctx, () => {
      expect(a.current()?.kind).toBe('scoped');
      expect(b.current()).toBeNull();
    });
  });
});
