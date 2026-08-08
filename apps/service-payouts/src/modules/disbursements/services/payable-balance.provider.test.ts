import { describe, expect, it } from 'vitest';

import { PayableBalanceProvider } from './payable-balance.provider';

describe('PayableBalanceProvider (stub)', () => {
  it('returns null for an unknown provider/currency pair', async () => {
    const provider = new PayableBalanceProvider();
    const snap = await provider.getBalance({ providerId: 'pr_a', currency: 'USD' });
    expect(snap).toBeNull();
  });

  it('round-trips a balance set via setBalance', async () => {
    const provider = new PayableBalanceProvider();
    const lastUpdatedAt = new Date('2026-05-10T12:00:00Z');
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 12_345,
      lastUpdatedAt,
    });
    const snap = await provider.getBalance({ providerId: 'pr_a', currency: 'USD' });
    expect(snap).not.toBeNull();
    expect(snap?.amountMinor).toBe(12_345);
    expect(snap?.lastUpdatedAt).toEqual(lastUpdatedAt);
  });

  it('isolates by currency for the same provider', async () => {
    const provider = new PayableBalanceProvider();
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 100,
      lastUpdatedAt: new Date(),
    });
    const eur = await provider.getBalance({ providerId: 'pr_a', currency: 'EUR' });
    expect(eur).toBeNull();
  });

  it('listAllBalances returns every balance in the requested currency', async () => {
    const provider = new PayableBalanceProvider();
    const now = new Date();
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 100,
      lastUpdatedAt: now,
    });
    provider.setBalance({
      providerId: 'pr_b',
      currency: 'USD',
      amountMinor: 200,
      lastUpdatedAt: now,
    });
    provider.setBalance({
      providerId: 'pr_c',
      currency: 'EUR',
      amountMinor: 999,
      lastUpdatedAt: now,
    });
    const list = await provider.listAllBalances({ currency: 'USD' });
    expect(list).not.toBeNull();
    expect(list?.length).toBe(2);
    expect(list?.map((s) => s.providerId).sort()).toEqual(['pr_a', 'pr_b']);
  });

  it('listAllBalances honours the providerIds allow-list', async () => {
    const provider = new PayableBalanceProvider();
    const now = new Date();
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 100,
      lastUpdatedAt: now,
    });
    provider.setBalance({
      providerId: 'pr_b',
      currency: 'USD',
      amountMinor: 200,
      lastUpdatedAt: now,
    });
    const list = await provider.listAllBalances({ currency: 'USD', providerIds: ['pr_a'] });
    expect(list?.length).toBe(1);
    expect(list?.[0]?.providerId).toBe('pr_a');
  });

  it('listAllBalances skips providers with no balance row in the allow-list', async () => {
    const provider = new PayableBalanceProvider();
    const now = new Date();
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 100,
      lastUpdatedAt: now,
    });
    const list = await provider.listAllBalances({
      currency: 'USD',
      providerIds: ['pr_a', 'pr_missing'],
    });
    expect(list?.length).toBe(1);
    expect(list?.[0]?.providerId).toBe('pr_a');
  });

  it('decrementBalanceForStubMode subtracts the disbursed amount', () => {
    const provider = new PayableBalanceProvider();
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 1_000,
      lastUpdatedAt: new Date(),
    });
    provider.decrementBalanceForStubMode({ providerId: 'pr_a', currency: 'USD', amountMinor: 400 });
    return provider.getBalance({ providerId: 'pr_a', currency: 'USD' }).then((snap) => {
      expect(snap?.amountMinor).toBe(600);
    });
  });

  it('decrementBalanceForStubMode clamps to zero', () => {
    const provider = new PayableBalanceProvider();
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 100,
      lastUpdatedAt: new Date(),
    });
    provider.decrementBalanceForStubMode({ providerId: 'pr_a', currency: 'USD', amountMinor: 999 });
    return provider.getBalance({ providerId: 'pr_a', currency: 'USD' }).then((snap) => {
      expect(snap?.amountMinor).toBe(0);
    });
  });

  it('decrementBalanceForStubMode is a no-op for unknown providers', () => {
    const provider = new PayableBalanceProvider();
    provider.decrementBalanceForStubMode({
      providerId: 'pr_ghost',
      currency: 'USD',
      amountMinor: 100,
    });
    // Should not throw.
    return provider
      .getBalance({ providerId: 'pr_ghost', currency: 'USD' })
      .then((snap) => expect(snap).toBeNull());
  });

  it('resetForTesting clears the store', async () => {
    const provider = new PayableBalanceProvider();
    provider.setBalance({
      providerId: 'pr_a',
      currency: 'USD',
      amountMinor: 100,
      lastUpdatedAt: new Date(),
    });
    provider.resetForTesting();
    const list = await provider.listAllBalances({ currency: 'USD' });
    expect(list).toEqual([]);
  });
});
