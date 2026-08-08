import { describe, expect, it, vi } from 'vitest';

import type { TenantContextStore } from '@taste-and-see/nest-prisma-tenant-scope';

import { ProviderBillingContactsController } from './provider-billing-contacts.controller';
import type { ProviderBillingContactsService } from '../services/provider-billing-contacts.service';

/**
 * Minimal store stand-in: `runWithoutTenantContext` needs a real
 * AsyncLocalStorage-shaped object, and the property under test is the
 * boundary parse rather than the frame itself (the boot-graph test covers
 * the wiring).
 */
function buildStore(): TenantContextStore {
  const { AsyncLocalStorage } = require('node:async_hooks') as {
    AsyncLocalStorage: new () => unknown;
  };
  return new AsyncLocalStorage() as unknown as TenantContextStore;
}

function buildService(
  contacts: readonly { providerId: string; ownerUserId: string }[],
): ProviderBillingContactsService {
  return {
    resolveBillingContacts: vi.fn(async () => ({ contacts })),
  } as unknown as ProviderBillingContactsService;
}

describe('ProviderBillingContactsController.resolveBillingContacts', () => {
  it('returns the resolved contacts', async () => {
    const controller = new ProviderBillingContactsController(
      buildService([{ providerId: 'prov_1', ownerUserId: 'usr_1' }]),
      buildStore(),
    );

    const result = await controller.resolveBillingContacts({ providerIds: ['prov_1'] });

    expect(result.contacts).toEqual([{ providerId: 'prov_1', ownerUserId: 'usr_1' }]);
  });

  it('returns a shorter list than requested without erroring', async () => {
    const controller = new ProviderBillingContactsController(
      buildService([{ providerId: 'prov_1', ownerUserId: 'usr_1' }]),
      buildStore(),
    );

    const result = await controller.resolveBillingContacts({
      providerIds: ['prov_1', 'prov_missing'],
    });

    expect(result.contacts).toHaveLength(1);
  });

  it('refuses to disclose a field the contract does not allow', async () => {
    // The boundary parse is a disclosure control: a later widened `select`
    // that started returning an email must break here, not ship.
    const leaky = {
      resolveBillingContacts: vi.fn(async () => ({
        contacts: [{ providerId: 'prov_1', ownerUserId: 'usr_1', email: 'chef@example.test' }],
      })),
    } as unknown as ProviderBillingContactsService;
    const controller = new ProviderBillingContactsController(leaky, buildStore());

    await expect(controller.resolveBillingContacts({ providerIds: ['prov_1'] })).rejects.toThrow();
  });

  it('passes the requested ids through unchanged', async () => {
    const service = buildService([]);
    const controller = new ProviderBillingContactsController(service, buildStore());

    await controller.resolveBillingContacts({ providerIds: ['prov_1', 'prov_2'] });

    expect(service.resolveBillingContacts).toHaveBeenCalledWith({
      providerIds: ['prov_1', 'prov_2'],
    });
  });
});
