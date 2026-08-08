import { Injectable, Logger } from '@nestjs/common';

import type { Prisma } from '../../../../prisma/generated';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { PayoutAccountsService, type PayoutAccountRecord } from './payout-accounts.service';

export interface IngestEventInput {
  readonly stripeEventId: string;
  readonly eventType: string;
  readonly stripeAccountId: string;
  readonly occurredAt: Date;
  readonly payload: {
    readonly detailsSubmitted: boolean;
    readonly chargesEnabled: boolean;
    readonly payoutsEnabled: boolean;
    readonly disabledReason?: string | null | undefined;
    readonly requirementsCurrentlyDue?: readonly string[] | undefined;
    readonly requirementsPastDue?: readonly string[] | undefined;
    readonly defaultCurrency?: string | null | undefined;
    readonly liveMode?: boolean | undefined;
  };
}

export type IngestEventResult =
  | {
      readonly outcome: 'applied' | 'replayed';
      readonly account: PayoutAccountRecord;
    }
  | {
      readonly outcome: 'ignored';
      readonly account: null;
    };

/**
 * Idempotent ingest of Stripe `account.updated` (and sibling) webhook
 * events.
 *
 * Flow:
 *   1. Look up `stripeEventId`. If present → return as `replayed` with
 *      the account at its current state. Stripe redeliveries are
 *      common; idempotency here is load-bearing.
 *   2. Inside a single transaction: insert the event row + apply the
 *      down-projected payload to the matching `provider_payout_accounts`
 *      row. If the stripeAccountId doesn't match any row → record the
 *      event with `outcome = ignored`, no account mutation.
 *   3. A concurrent retry that lands the same stripeEventId between
 *      step 1 and the INSERT hits P2002 — we catch + re-read.
 */
@Injectable()
export class StripeAccountEventsService {
  private readonly logger = new Logger(StripeAccountEventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: PayoutAccountsService,
  ) {}

  async ingest(input: IngestEventInput): Promise<IngestEventResult> {
    const existing = await this.prisma.stripeAccountEvent.findUnique({
      where: { stripeEventId: input.stripeEventId },
    });
    if (existing !== null) {
      // Replay — return the account at its CURRENT state (not the
      // state captured at first-application time). Callers care about
      // "what is the platform's view of this account now" more than
      // about the historical snapshot.
      if (existing.providerPayoutAccountId === null) {
        return { outcome: 'ignored', account: null };
      }
      const accountSnapshot = await this.accounts.getByStripeAccountId(input.stripeAccountId);
      if (accountSnapshot === null) {
        // The account row got deleted out from under us (admin-side
        // hard delete). Treat as ignored on the replay path.
        return { outcome: 'ignored', account: null };
      }
      return { outcome: 'replayed', account: accountSnapshot };
    }

    try {
      // The callback carries an explicit return type: without it the
      // bare `return { outcome: 'applied', ... }` literal has no
      // contextual type, so `outcome` widens from the literal to
      // `string` and the whole discriminated union collapses to
      // `{ outcome: string }` (TS-501).
      return await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<IngestEventResult> => {
          const applied = await this.accounts.applyAccountUpdate(tx, {
            stripeAccountId: input.stripeAccountId,
            chargesEnabled: input.payload.chargesEnabled,
            payoutsEnabled: input.payload.payoutsEnabled,
            detailsSubmitted: input.payload.detailsSubmitted,
            requirementsCurrentlyDue: input.payload.requirementsCurrentlyDue ?? [],
            requirementsPastDue: input.payload.requirementsPastDue ?? [],
            disabledReason: input.payload.disabledReason ?? null,
            liveMode: input.payload.liveMode ?? false,
          });

          const outcome: 'applied' | 'ignored' = applied === null ? 'ignored' : 'applied';
          if (applied === null) {
            this.logger.warn(
              `ignoring stripe ${input.eventType} for unknown account id=${input.stripeAccountId} eventId=${input.stripeEventId}`,
            );
          }

          await tx.stripeAccountEvent.create({
            data: {
              stripeEventId: input.stripeEventId,
              eventType: input.eventType,
              stripeAccountId: input.stripeAccountId,
              providerPayoutAccountId: applied !== null ? applied.id : null,
              occurredAt: input.occurredAt,
              payload: structuredClonePayload(input.payload),
              outcome,
            },
          });

          if (applied === null) {
            return { outcome: 'ignored', account: null };
          }
          return { outcome: 'applied', account: applied };
        },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Concurrent retry won the UNIQUE race — re-read the now-
        // persisted row + snapshot the account.
        const winner = await this.prisma.stripeAccountEvent.findUnique({
          where: { stripeEventId: input.stripeEventId },
        });
        if (winner !== null) {
          if (winner.providerPayoutAccountId === null) {
            return { outcome: 'ignored', account: null };
          }
          const accountSnapshot = await this.accounts.getByStripeAccountId(input.stripeAccountId);
          if (accountSnapshot === null) {
            return { outcome: 'ignored', account: null };
          }
          return { outcome: 'replayed', account: accountSnapshot };
        }
      }
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const r = err as Record<string, unknown>;
  return r['code'] === 'P2002';
}

/**
 * Convert the optional-fields payload into a plain JSON-serialisable
 * object Prisma can store as JSONB. Drops `undefined` values; nulls are
 * preserved.
 */
function structuredClonePayload(payload: IngestEventInput['payload']): Prisma.InputJsonValue {
  const out: Record<string, unknown> = {
    detailsSubmitted: payload.detailsSubmitted,
    chargesEnabled: payload.chargesEnabled,
    payoutsEnabled: payload.payoutsEnabled,
  };
  if (payload.disabledReason !== undefined) out['disabledReason'] = payload.disabledReason;
  if (payload.requirementsCurrentlyDue !== undefined) {
    out['requirementsCurrentlyDue'] = [...payload.requirementsCurrentlyDue];
  }
  if (payload.requirementsPastDue !== undefined) {
    out['requirementsPastDue'] = [...payload.requirementsPastDue];
  }
  if (payload.defaultCurrency !== undefined) out['defaultCurrency'] = payload.defaultCurrency;
  if (payload.liveMode !== undefined) out['liveMode'] = payload.liveMode;
  // `out` is JSON-safe by construction — every branch above assigns a
  // boolean, a string, `null`, or a string[]. `Prisma.InputJsonObject`
  // can't be used as the accumulator type directly because its mapped
  // index signature is `readonly`, which rejects the `out[k] = v` writes.
  return out as Prisma.InputJsonValue;
}
