import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { ProviderBillingContactsService } from './provider-billing-contacts.service';

interface StoredProvider {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly deletedAt: Date | null;
}

interface FindManyArgs {
  readonly where?: { readonly id?: { readonly in?: readonly string[] } };
  readonly select?: Record<string, boolean>;
}

function buildPrisma(rows: readonly StoredProvider[]): {
  prisma: PrismaService;
  lastArgs: () => FindManyArgs | undefined;
} {
  let captured: FindManyArgs | undefined;
  const prisma = {
    provider: {
      findMany: vi.fn(async (args: FindManyArgs) => {
        captured = args;
        const ids = args.where?.id?.in ?? [];
        return rows.filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, userId: r.userId }));
      }),
    },
  } as unknown as PrismaService;
  return { prisma, lastArgs: () => captured };
}

const ACTIVE: StoredProvider = {
  id: 'prov_1',
  userId: 'usr_1',
  status: 'active',
  deletedAt: null,
};

describe('ProviderBillingContactsService.resolveBillingContacts', () => {
  it('resolves a provider to its owning account', async () => {
    const { prisma } = buildPrisma([ACTIVE]);
    const service = new ProviderBillingContactsService(prisma);

    const result = await service.resolveBillingContacts({ providerIds: ['prov_1'] });

    expect(result.contacts).toEqual([{ providerId: 'prov_1', ownerUserId: 'usr_1' }]);
  });

  it('resolves a suspended, archived or soft-deleted provider too', async () => {
    // The point of the route: a provider whose profile is archived can
    // still hold a live subscription, and filtering here would make exactly
    // that customer unreachable while looking like a clean empty result.
    // Deliverability is decided one hop later, by identity.
    const { prisma } = buildPrisma([
      { id: 'prov_susp', userId: 'usr_s', status: 'suspended', deletedAt: null },
      { id: 'prov_arch', userId: 'usr_a', status: 'archived', deletedAt: null },
      { id: 'prov_del', userId: 'usr_d', status: 'active', deletedAt: new Date() },
    ]);
    const service = new ProviderBillingContactsService(prisma);

    const result = await service.resolveBillingContacts({
      providerIds: ['prov_susp', 'prov_arch', 'prov_del'],
    });

    expect(result.contacts).toHaveLength(3);
  });

  it('omits a provider id that matches no row rather than returning a null owner', async () => {
    const { prisma } = buildPrisma([ACTIVE]);
    const service = new ProviderBillingContactsService(prisma);

    const result = await service.resolveBillingContacts({
      providerIds: ['prov_1', 'prov_missing'],
    });

    expect(result.contacts.map((c) => c.providerId)).toEqual(['prov_1']);
  });

  it('deduplicates the requested ids', async () => {
    const { prisma, lastArgs } = buildPrisma([ACTIVE]);
    const service = new ProviderBillingContactsService(prisma);

    const result = await service.resolveBillingContacts({
      providerIds: ['prov_1', 'prov_1', 'prov_1'],
    });

    expect(lastArgs()?.where?.id?.in).toEqual(['prov_1']);
    // And a duplicate request must not produce a duplicate recipient — the
    // consumer mails one message per contact.
    expect(result.contacts).toHaveLength(1);
  });

  it('selects only the two columns the route may disclose', async () => {
    // A display name or an email here would make this route, on its own, a
    // way to turn a subscription id into a mailable identity — the exact
    // property the two-hop split exists to deny.
    const { prisma, lastArgs } = buildPrisma([ACTIVE]);
    const service = new ProviderBillingContactsService(prisma);

    await service.resolveBillingContacts({ providerIds: ['prov_1'] });

    expect(lastArgs()?.select).toEqual({ id: true, userId: true });
  });

  it('returns an empty list without failing when nothing resolves', async () => {
    const { prisma } = buildPrisma([]);
    const service = new ProviderBillingContactsService(prisma);

    const result = await service.resolveBillingContacts({ providerIds: ['prov_x'] });

    expect(result.contacts).toEqual([]);
  });
});
