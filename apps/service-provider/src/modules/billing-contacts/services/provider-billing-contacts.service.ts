import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';

export interface ProviderBillingContactRow {
  readonly providerId: string;
  readonly ownerUserId: string;
}

/**
 * Resolves provider ids to the user id of the account that owns each
 * (TS-042-followup-3a1a).
 *
 * The provider half of the billing-contact chain. See the contract module
 * `provider-billing-contact.schema.ts` for why `ownerUserId` is singular
 * (`providers.user_id` is `@unique`) and why no status filter is applied.
 *
 * **Two columns, and only two.** `select` is deliberately narrow: a
 * display name or an email leaving on this route would make it, on its own,
 * a way to turn a subscription id into a mailable identity — the exact
 * property the two-hop split exists to deny (TS-042-followup-3a1).
 */
@Injectable()
export class ProviderBillingContactsService {
  private readonly logger = new Logger(ProviderBillingContactsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveBillingContacts(input: {
    readonly providerIds: readonly string[];
  }): Promise<{ readonly contacts: readonly ProviderBillingContactRow[] }> {
    const providerIds = [...new Set(input.providerIds)];

    const rows = (await this.prisma.provider.findMany({
      where: { id: { in: providerIds } },
      select: { id: true, userId: true },
    })) as readonly { readonly id: string; readonly userId: string }[];

    const contacts = rows.map((row) => ({
      providerId: row.id,
      ownerUserId: row.userId,
    }));

    if (contacts.length < providerIds.length) {
      // A provider id in a subscription that matches no row is a dangling
      // reference, and the consequence is a paying customer nobody can
      // reach. WARN rather than log — the count is the alertable fact, and
      // the ids identify which subscriptions to look at.
      const found = new Set(contacts.map((c) => c.providerId));
      this.logger.warn(
        {
          requestedCount: providerIds.length,
          resolvedCount: contacts.length,
          unresolvedProviderIds: providerIds.filter((id) => !found.has(id)),
        },
        'provider.billing-contacts.unresolved',
      );
    }

    return { contacts };
  }
}
