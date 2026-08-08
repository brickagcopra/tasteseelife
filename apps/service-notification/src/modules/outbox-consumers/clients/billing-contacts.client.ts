import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InternalHouseholdBillingContactsResponseSchema,
  InternalProviderBillingContactsResponseSchema,
  InternalRecipientContactsResponseSchema,
  type HouseholdBillingContact,
  type ProviderBillingContact,
  type RecipientContact,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * The two internal reads the dunning ladder needs to turn an event into an
 * inbox (TS-042-followup-3a2).
 *
 * A dunning event carries a `customerId` and a `customerGroup`, and nothing
 * else about who to tell. Neither hop alone yields a mailable identity, and
 * that is deliberate (TS-042-followup-3a1): service-household hands back
 * user ids and no addresses; service-identity turns user ids into addresses
 * and knows nothing about households. Compromising either service on its own
 * does not produce a list of who pays for whose care.
 *
 * **Both hops are shared-secret-pinned in-cluster POSTs**, never routed
 * through the gateway — they are service-to-service reads of data no browser
 * may see.
 *
 * **Failures THROW.** The consumer SDK redelivers on a thrown handler, which
 * is the behaviour we want: service-household being briefly down must not
 * consume the event and silently drop the family's notification. A partial
 * answer is a different matter and is the caller's to judge — see
 * `DunningLadderService`.
 */
@Injectable()
export class BillingContactsClient {
  private readonly logger = new Logger(BillingContactsClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  /**
   * Household ids → the user ids of their active `primary_payer` members.
   *
   * A household with no active payer is ABSENT from the response, not an
   * empty-array row — the route makes that unrepresentable. So a shorter
   * list than the request is a real signal, not a rounding error.
   */
  async resolveHouseholdPayers(
    householdIds: readonly string[],
  ): Promise<HouseholdBillingContact[]> {
    const url = `${trimBaseUrl(this.env.HOUSEHOLD_SERVICE_BASE_URL)}/api/v1/internal/households/billing-contacts`;
    const body = await this.postJson(
      url,
      { householdIds: [...householdIds] },
      this.env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME,
      this.env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY,
      'household-billing-contacts',
    );
    // Re-parse at the boundary. `.strict()` here is a drift check AND a
    // disclosure control: a widened projection upstream that started
    // returning observer or senior user ids would fail here rather than
    // quietly mail a senior about their family's card being declined
    // (CLAUDE.md §12).
    return InternalHouseholdBillingContactsResponseSchema.parse(body).contacts;
  }

  /**
   * Provider ids → the user id of the account that owns each
   * (TS-042-followup-3a1a).
   *
   * The `provider` customer-group twin of `resolveHouseholdPayers`, and the
   * shape differs on purpose: one owner, not an array of payers, because
   * `provider.providers.user_id` is `@unique`. A provider id matching no
   * row is ABSENT from the response, so a short list is a real signal here
   * too — it means a subscription points at a provider that no longer
   * exists.
   */
  async resolveProviderOwners(providerIds: readonly string[]): Promise<ProviderBillingContact[]> {
    const url = `${trimBaseUrl(this.env.PROVIDER_SERVICE_BASE_URL)}/api/v1/internal/providers/billing-contacts`;
    const body = await this.postJson(
      url,
      { providerIds: [...providerIds] },
      this.env.PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME,
      this.env.PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY,
      'provider-billing-contacts',
    );
    // Same boundary re-parse, same two reasons: drift, and disclosure. A
    // widened projection upstream that started returning an address would
    // fail here rather than quietly make this one hop sufficient to turn a
    // subscription id into a mailable identity.
    return InternalProviderBillingContactsResponseSchema.parse(body).contacts;
  }

  /**
   * User ids → email + account status.
   *
   * A userId with no matching user row is simply absent from `contacts`;
   * the caller must treat a short answer as unresolved recipients, never as
   * "nobody to tell".
   */
  async resolveRecipientContacts(userIds: readonly string[]): Promise<RecipientContact[]> {
    const url = `${trimBaseUrl(this.env.IDENTITY_SERVICE_BASE_URL)}/api/v1/internal/identity/recipient-contacts`;
    const body = await this.postJson(
      url,
      { userIds: [...userIds] },
      this.env.IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME,
      this.env.IDENTITY_RECIPIENT_CONTACTS_API_KEY,
      'identity-recipient-contacts',
    );
    return InternalRecipientContactsResponseSchema.parse(body).contacts;
  }

  private async postJson(
    url: string,
    payload: unknown,
    headerName: string,
    apiKey: string,
    operation: string,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [headerName]: apiKey },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      // Never log the key or the URL's credentials; the operation name is
      // what an operator needs to find the hop.
      this.logger.error(
        { operation, err: err instanceof Error ? err.message : String(err) },
        'dunning.internal-read.transport-failed',
      );
      throw new Error(`${operation}: transport failure`);
    }

    if (!response.ok) {
      this.logger.error({ operation, status: response.status }, 'dunning.internal-read.failed');
      throw new Error(`${operation}: HTTP ${response.status}`);
    }

    return (await response.json()) as unknown;
  }
}

/** Strips a trailing slash so the joined path never doubles it. */
function trimBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}
