import { describe, expect, it } from 'vitest';

import { PlanAccountResolverService } from './plan-account-resolver.service';

describe('PlanAccountResolverService.resolve', () => {
  const resolver = new PlanAccountResolverService();

  it('maps family tiers to the matching deferred + revenue codes', () => {
    expect(resolver.resolve('family.tier1')).toEqual({
      deferredAccountCode: '2000.family.tier1',
      revenueAccountCode: '4000.family.tier1',
    });
    expect(resolver.resolve('family.tier2')).toEqual({
      deferredAccountCode: '2000.family.tier2',
      revenueAccountCode: '4000.family.tier2',
    });
    expect(resolver.resolve('family.tier3')).toEqual({
      deferredAccountCode: '2000.family.tier3',
      revenueAccountCode: '4000.family.tier3',
    });
  });

  it('maps provider tiers to the matching deferred + revenue codes', () => {
    expect(resolver.resolve('provider.basic')).toEqual({
      deferredAccountCode: '2000.provider.basic',
      revenueAccountCode: '4000.provider.basic',
    });
    expect(resolver.resolve('provider.certified')).toEqual({
      deferredAccountCode: '2000.provider.certified',
      revenueAccountCode: '4000.provider.certified',
    });
    expect(resolver.resolve('provider.elite')).toEqual({
      deferredAccountCode: '2000.provider.elite',
      revenueAccountCode: '4000.provider.elite',
    });
  });

  it('maps academy membership to the matching deferred + revenue codes', () => {
    expect(resolver.resolve('academy.membership')).toEqual({
      deferredAccountCode: '2000.academy.membership',
      revenueAccountCode: '4000.academy.membership',
    });
  });

  it('is a pure string concatenation (no special-casing)', () => {
    // The contract for new plans landing later: as long as the seed
    // catalog adds matching `2000.{code}` + `4000.{code}` rows,
    // the resolver doesn't need updating.
    expect(resolver.resolve('partner.luxe')).toEqual({
      deferredAccountCode: '2000.partner.luxe',
      revenueAccountCode: '4000.partner.luxe',
    });
  });
});
