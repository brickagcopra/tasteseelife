import {
  type CreateAccountLinkResponse,
  CreateAccountLinkResponseSchema,
  type CreateConnectAccountResponse,
  CreateConnectAccountResponseSchema,
  type IngestStripeAccountEventResponse,
  IngestStripeAccountEventResponseSchema,
  type PayoutAccountResponse,
  PayoutAccountResponseSchema,
  type PayoutAccountsListResponse,
  PayoutAccountsListResponseSchema,
} from '@taste-and-see/contracts';

import type { AccountLinkRecord, PayoutAccountRecord } from '../services/payout-accounts.service';

/**
 * Domain → wire DTO mappers (CLAUDE.md §3.3 — never return raw Prisma
 * objects to the client).
 *
 * Each mapper parses-via-contract before returning so a future drift
 * between the service-layer shape and the wire contract surfaces at the
 * boundary, not at the consumer.
 */
export function toPayoutAccountResponse(record: PayoutAccountRecord): PayoutAccountResponse {
  return PayoutAccountResponseSchema.parse({
    providerId: record.providerId,
    stripeAccountId: record.stripeAccountId,
    country: record.country,
    defaultCurrency: record.defaultCurrency,
    status: record.status,
    chargesEnabled: record.chargesEnabled,
    payoutsEnabled: record.payoutsEnabled,
    detailsSubmitted: record.detailsSubmitted,
    liveMode: record.liveMode,
    requirementsCurrentlyDue: [...record.requirementsCurrentlyDue],
    requirementsPastDue: [...record.requirementsPastDue],
    disabledReason: record.disabledReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toCreateConnectAccountResponse(
  outcome: 'created' | 'existing',
  record: PayoutAccountRecord,
): CreateConnectAccountResponse {
  return CreateConnectAccountResponseSchema.parse({
    outcome,
    account: toPayoutAccountResponse(record),
  });
}

export function toCreateAccountLinkResponse(link: AccountLinkRecord): CreateAccountLinkResponse {
  return CreateAccountLinkResponseSchema.parse({
    kind: link.kind,
    url: link.url,
    expiresAt: link.expiresAt.toISOString(),
    liveMode: link.liveMode,
  });
}

export function toIngestStripeAccountEventResponse(
  outcome: 'applied' | 'replayed' | 'ignored',
  record: PayoutAccountRecord | null,
): IngestStripeAccountEventResponse {
  return IngestStripeAccountEventResponseSchema.parse({
    outcome,
    account: record === null ? null : toPayoutAccountResponse(record),
  });
}

export function toPayoutAccountsListResponse(
  records: readonly PayoutAccountRecord[],
  nextCursor: string | null,
): PayoutAccountsListResponse {
  return PayoutAccountsListResponseSchema.parse({
    rows: records.map(toPayoutAccountResponse),
    nextCursor,
  });
}
