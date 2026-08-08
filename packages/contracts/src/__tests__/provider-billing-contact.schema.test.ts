import { describe, expect, it } from 'vitest';

import {
  InternalProviderBillingContactsRequestSchema,
  InternalProviderBillingContactsResponseSchema,
  ProviderBillingContactSchema,
  PROVIDER_BILLING_CONTACT_BATCH_MAX,
} from '../http/provider-billing-contact.schema';

describe('InternalProviderBillingContactsRequestSchema', () => {
  it('accepts a batch of provider ids', () => {
    const parsed = InternalProviderBillingContactsRequestSchema.parse({
      providerIds: ['prov_1', 'prov_2'],
    });
    expect(parsed.providerIds).toEqual(['prov_1', 'prov_2']);
  });

  it('rejects an empty batch', () => {
    expect(
      InternalProviderBillingContactsRequestSchema.safeParse({ providerIds: [] }).success,
    ).toBe(false);
  });

  it('rejects a batch over the cap', () => {
    expect(
      InternalProviderBillingContactsRequestSchema.safeParse({
        providerIds: Array.from(
          { length: PROVIDER_BILLING_CONTACT_BATCH_MAX + 1 },
          (_, i) => `prov_${i}`,
        ),
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      InternalProviderBillingContactsRequestSchema.safeParse({
        providerIds: ['prov_1'],
        includeInactive: true,
      }).success,
    ).toBe(false);
  });
});

describe('ProviderBillingContactSchema', () => {
  it('carries exactly one owner, not a list', () => {
    // `providers.user_id` is `@unique`. An array here would assert a
    // plurality the database forbids, and the household route's array shape
    // exists for the opposite reason — a household really can have several
    // payers.
    const parsed = ProviderBillingContactSchema.parse({
      providerId: 'prov_1',
      ownerUserId: 'usr_1',
    });
    expect(parsed.ownerUserId).toBe('usr_1');
  });

  it('rejects an array of owners', () => {
    expect(
      ProviderBillingContactSchema.safeParse({
        providerId: 'prov_1',
        ownerUserId: ['usr_1', 'usr_2'],
      }).success,
    ).toBe(false);
  });

  it('rejects a null owner — an unresolved provider is absent, not null', () => {
    expect(
      ProviderBillingContactSchema.safeParse({ providerId: 'prov_1', ownerUserId: null }).success,
    ).toBe(false);
  });

  it('rejects a contact field the route must not disclose', () => {
    // The two-hop split: this route answers "whose account", identity's
    // answers "how to reach them". Neither alone yields a mailable identity.
    expect(
      ProviderBillingContactSchema.safeParse({
        providerId: 'prov_1',
        ownerUserId: 'usr_1',
        email: 'chef@example.test',
      }).success,
    ).toBe(false);
    expect(
      ProviderBillingContactSchema.safeParse({
        providerId: 'prov_1',
        ownerUserId: 'usr_1',
        displayName: 'Chef Ada',
      }).success,
    ).toBe(false);
  });
});

describe('InternalProviderBillingContactsResponseSchema', () => {
  it('accepts an empty contacts list', () => {
    const parsed = InternalProviderBillingContactsResponseSchema.parse({ contacts: [] });
    expect(parsed.contacts).toEqual([]);
  });

  it('accepts a list shorter than the request', () => {
    const parsed = InternalProviderBillingContactsResponseSchema.parse({
      contacts: [{ providerId: 'prov_1', ownerUserId: 'usr_1' }],
    });
    expect(parsed.contacts).toHaveLength(1);
  });

  it('rejects unknown fields (strict)', () => {
    expect(
      InternalProviderBillingContactsResponseSchema.safeParse({
        contacts: [],
        unresolvedProviderIds: ['prov_2'],
      }).success,
    ).toBe(false);
  });
});
