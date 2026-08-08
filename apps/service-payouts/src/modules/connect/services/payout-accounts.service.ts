import { Injectable, Logger } from '@nestjs/common';
import type { PayoutAccountStatus } from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { StripeConnectService } from './stripe-connect.service';

/**
 * Service-layer view of a provider payout account row. Decoupled from
 * Prisma's generated `ProviderPayoutAccount` type so the service-layer
 * boundary is unambiguous (CLAUDE.md §3.3 — DTO mappers everywhere) and
 * so the future cleanup that drops local row-type mirrors (lands with
 * Prisma 5.23 / 6.x) is a code-move.
 */
export interface PayoutAccountRecord {
  readonly id: string;
  readonly providerId: string;
  readonly stripeAccountId: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly status: PayoutAccountStatus;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
  readonly requirementsCurrentlyDue: readonly string[];
  readonly requirementsPastDue: readonly string[];
  readonly disabledReason: string | null;
  readonly liveMode: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateOrFetchInput {
  readonly providerId: string;
  readonly country: string;
  readonly defaultCurrency: string;
}

export interface CreateOrFetchResult {
  readonly outcome: 'created' | 'existing';
  readonly account: PayoutAccountRecord;
}

export interface AccountLinkRecord {
  readonly kind: 'account_onboarding' | 'account_update';
  readonly url: string;
  readonly expiresAt: Date;
  readonly liveMode: boolean;
}

export interface PayoutAccountsListResult {
  readonly rows: readonly PayoutAccountRecord[];
  readonly nextCursor: string | null;
}

/**
 * Internal payload shape used by the stripe-events ingest. Kept as a
 * plain interface so the upstream caller (StripeAccountEventsService)
 * doesn't need to import the contract types.
 */
export interface ApplyStripeAccountUpdateInput {
  readonly stripeAccountId: string;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
  readonly requirementsCurrentlyDue: readonly string[];
  readonly requirementsPastDue: readonly string[];
  readonly disabledReason: string | null;
  readonly liveMode: boolean;
}

/**
 * Persistence + status-derivation for `provider_payout_accounts`.
 *
 * Responsibilities:
 *   1. Idempotent create — `createOrFetchForProvider` mints a Stripe
 *      Express account once per provider; subsequent calls return the
 *      existing row. The UNIQUE constraint on `provider_id` is the
 *      authoritative dedup mechanism; the service catches P2002 to
 *      handle the rare concurrent-create race.
 *   2. Onboarding-link issuance — `mintAccountLink` calls Stripe (or
 *      the stub) and persists a `payout_account_link_events` audit row.
 *   3. Status derivation — `deriveStatus` collapses the four boolean +
 *      requirements signals into a single `PayoutAccountStatus`.
 *   4. Apply Stripe `account.updated` — `applyAccountUpdate` refreshes
 *      the row + recomputes the status. Called from
 *      StripeAccountEventsService inside an existing transaction.
 */
@Injectable()
export class PayoutAccountsService {
  private readonly logger = new Logger(PayoutAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeConnect: StripeConnectService,
  ) {}

  /**
   * Mint a Stripe Connect Express account for the provider OR return
   * the existing row if one is already on file.
   *
   * **Idempotency contract.** Two concurrent calls with the same
   * `providerId` will both reach the Stripe create call (we issue the
   * SDK call BEFORE inserting). The DB UNIQUE constraint on
   * `provider_id` makes the second insert hit P2002 — we catch that,
   * read the row that won the race, and return it. The Stripe account
   * minted by the loser is left orphaned; future TS-090-followup-2
   * reconciliation worker will void it on the live side.
   */
  async createOrFetchForProvider(input: CreateOrFetchInput): Promise<CreateOrFetchResult> {
    const existing = await this.prisma.providerPayoutAccount.findUnique({
      where: { providerId: input.providerId },
    });
    if (existing !== null) {
      return { outcome: 'existing', account: rowToRecord(existing) };
    }

    const stripeOut = await this.stripeConnect.createConnectAccount({
      providerId: input.providerId,
      country: input.country,
      defaultCurrency: input.defaultCurrency,
    });

    const derivedStatus = deriveStatus({
      chargesEnabled: stripeOut.chargesEnabled,
      payoutsEnabled: stripeOut.payoutsEnabled,
      detailsSubmitted: stripeOut.detailsSubmitted,
      requirementsCurrentlyDue: stripeOut.requirementsCurrentlyDue,
      requirementsPastDue: stripeOut.requirementsPastDue,
      disabledReason: stripeOut.disabledReason,
    });

    try {
      const row = await this.prisma.providerPayoutAccount.create({
        data: {
          providerId: input.providerId,
          stripeAccountId: stripeOut.stripeAccountId,
          country: stripeOut.country,
          defaultCurrency: stripeOut.defaultCurrency,
          status: derivedStatus,
          chargesEnabled: stripeOut.chargesEnabled,
          payoutsEnabled: stripeOut.payoutsEnabled,
          detailsSubmitted: stripeOut.detailsSubmitted,
          requirementsCurrentlyDue: [...stripeOut.requirementsCurrentlyDue],
          requirementsPastDue: [...stripeOut.requirementsPastDue],
          disabledReason: stripeOut.disabledReason,
          liveMode: stripeOut.liveMode,
        },
      });
      return { outcome: 'created', account: rowToRecord(row) };
    } catch (err) {
      // P2002 — concurrent create raced past the findUnique.
      if (isUniqueViolation(err)) {
        const winner = await this.prisma.providerPayoutAccount.findUnique({
          where: { providerId: input.providerId },
        });
        if (winner !== null) {
          this.logger.warn(
            `concurrent-create race resolved providerId=${input.providerId} winnerStripeId=${winner.stripeAccountId}`,
          );
          return { outcome: 'existing', account: rowToRecord(winner) };
        }
      }
      throw err;
    }
  }

  /**
   * Mint a fresh Stripe account link and persist an audit row.
   * Returns the link details for the controller to echo to the caller.
   */
  async mintAccountLink(input: MintLinkInput): Promise<MintLinkResult> {
    const account = await this.prisma.providerPayoutAccount.findUnique({
      where: { providerId: input.providerId },
    });
    if (account === null) {
      return { outcome: 'account_not_found' };
    }

    const kind: 'account_onboarding' | 'account_update' = input.kind ?? 'account_onboarding';
    const stripeOut = await this.stripeConnect.createAccountLink({
      stripeAccountId: account.stripeAccountId,
      kind,
      refreshUrl: input.refreshUrl,
      returnUrl: input.returnUrl,
    });

    await this.prisma.payoutAccountLinkEvent.create({
      data: {
        providerPayoutAccountId: account.id,
        kind,
        url: stripeOut.url,
        expiresAt: stripeOut.expiresAt,
        liveMode: stripeOut.liveMode,
      },
    });

    return {
      outcome: 'minted',
      link: {
        kind,
        url: stripeOut.url,
        expiresAt: stripeOut.expiresAt,
        liveMode: stripeOut.liveMode,
      },
    };
  }

  async getByProvider(providerId: string): Promise<PayoutAccountRecord | null> {
    const row = await this.prisma.providerPayoutAccount.findUnique({
      where: { providerId },
    });
    return row === null ? null : rowToRecord(row);
  }

  async getByStripeAccountId(stripeAccountId: string): Promise<PayoutAccountRecord | null> {
    const row = await this.prisma.providerPayoutAccount.findUnique({
      where: { stripeAccountId },
    });
    return row === null ? null : rowToRecord(row);
  }

  /**
   * Admin cursor-paginated list. Cursor encodes the surrogate `id` of
   * the last row returned. We use simple `(createdAt DESC, id DESC)`
   * ordering (created_at is the natural admin sort) with the cursor
   * carrying the `id` from the boundary row.
   */
  async list(input: ListAccountsInput): Promise<PayoutAccountsListResult> {
    const where: Record<string, unknown> = {};
    if (input.status !== undefined) where['status'] = input.status;

    // Cursor handling — fetch limit+1 to detect "is there another page".
    const findArgs: Record<string, unknown> = {
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    };
    if (input.cursor !== undefined) {
      findArgs['cursor'] = { id: input.cursor };
      findArgs['skip'] = 1;
    }

    const rows = await this.prisma.providerPayoutAccount.findMany(findArgs as never);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const nextCursor = hasMore ? (page[page.length - 1]?.id ?? null) : null;

    return {
      rows: page.map(rowToRecord),
      nextCursor,
    };
  }

  /**
   * Apply a Stripe `account.updated` payload to the row. Called from
   * inside StripeAccountEventsService's transaction so the update +
   * the event-log INSERT are atomic.
   *
   * Returns the updated record. A null return means the
   * stripeAccountId did not match any row on file — the caller treats
   * that as an `outcome = ignored` event.
   */
  async applyAccountUpdate(
    tx: PrismaTransactionClient,
    input: ApplyStripeAccountUpdateInput,
  ): Promise<PayoutAccountRecord | null> {
    const existing = await tx.providerPayoutAccount.findUnique({
      where: { stripeAccountId: input.stripeAccountId },
    });
    if (existing === null) return null;

    const derivedStatus = deriveStatus({
      chargesEnabled: input.chargesEnabled,
      payoutsEnabled: input.payoutsEnabled,
      detailsSubmitted: input.detailsSubmitted,
      requirementsCurrentlyDue: input.requirementsCurrentlyDue,
      requirementsPastDue: input.requirementsPastDue,
      disabledReason: input.disabledReason,
    });

    const updated = await tx.providerPayoutAccount.update({
      where: { id: existing.id },
      data: {
        status: derivedStatus,
        chargesEnabled: input.chargesEnabled,
        payoutsEnabled: input.payoutsEnabled,
        detailsSubmitted: input.detailsSubmitted,
        requirementsCurrentlyDue: [...input.requirementsCurrentlyDue],
        requirementsPastDue: [...input.requirementsPastDue],
        disabledReason: input.disabledReason,
        liveMode: input.liveMode,
      },
    });

    return rowToRecord(updated);
  }
}

export interface MintLinkInput {
  readonly providerId: string;
  readonly kind?: 'account_onboarding' | 'account_update';
  readonly refreshUrl: string;
  readonly returnUrl: string;
}

export type MintLinkResult =
  | { readonly outcome: 'minted'; readonly link: AccountLinkRecord }
  | { readonly outcome: 'account_not_found' };

export interface ListAccountsInput {
  readonly limit: number;
  readonly status?: PayoutAccountStatus;
  readonly cursor?: string;
}

/**
 * Status derivation rule (TS-090):
 *
 *   - `disabled` when Stripe set a `disabled_reason`.
 *   - `pending_onboarding` when `details_submitted` is false.
 *   - `restricted` when any requirements are past due OR
 *     `charges_enabled` is false OR `payouts_enabled` is false.
 *   - `active` otherwise (details submitted + charges + payouts enabled
 *     + no past-due requirements).
 */
export function deriveStatus(input: {
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
  readonly requirementsCurrentlyDue: readonly string[];
  readonly requirementsPastDue: readonly string[];
  readonly disabledReason: string | null;
}): PayoutAccountStatus {
  if (input.disabledReason !== null && input.disabledReason !== '') {
    return 'disabled';
  }
  if (!input.detailsSubmitted) {
    return 'pending_onboarding';
  }
  if (input.requirementsPastDue.length > 0 || !input.chargesEnabled || !input.payoutsEnabled) {
    return 'restricted';
  }
  return 'active';
}

interface ProviderPayoutAccountRowShape {
  readonly id: string;
  readonly providerId: string;
  readonly stripeAccountId: string;
  readonly country: string;
  readonly defaultCurrency: string;
  readonly status: PayoutAccountStatus;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly detailsSubmitted: boolean;
  readonly requirementsCurrentlyDue: unknown;
  readonly requirementsPastDue: unknown;
  readonly disabledReason: string | null;
  readonly liveMode: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function rowToRecord(row: ProviderPayoutAccountRowShape): PayoutAccountRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    stripeAccountId: row.stripeAccountId,
    country: row.country,
    defaultCurrency: row.defaultCurrency,
    status: row.status,
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    detailsSubmitted: row.detailsSubmitted,
    requirementsCurrentlyDue: toStringArray(row.requirementsCurrentlyDue),
    requirementsPastDue: toStringArray(row.requirementsPastDue),
    disabledReason: row.disabledReason,
    liveMode: row.liveMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Duck-typed P2002 (unique-constraint violation) detection. Drops in
 * with the canonical `Prisma.PrismaClientKnownRequestError` once we
 * untangle the `@prisma/client` namespace value-side resolution (TS-021-
 * followup-2 cluster).
 */
function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const r = err as Record<string, unknown>;
  return r['code'] === 'P2002';
}

export const __testing = { deriveStatus, isUniqueViolation };
