import type {
  StripeReconciliationCategory,
  StripeReconciliationCheckRecord,
  StripeReconciliationMode,
  StripeReconciliationStatus,
} from '@taste-and-see/contracts';

import { aggregateToDecimal, decimalToMinor, utcDayKey } from '../services/reconciliation-math';

interface DecimalLike {
  toString(): string;
}

/**
 * Shape of a persisted `stripe_reconciliation_checks` row as read back
 * through Prisma. Declared locally rather than imported from
 * `@prisma/client` because the generated `Prisma` namespace's value side
 * resolves inconsistently under our tsconfig (TS-021-followup-3 root
 * cause); revisit on the next Prisma bump alongside the sibling cleanups
 * (TS-261-followup-7).
 */
export interface StripeReconciliationCheckRow {
  readonly reconciliationDate: Date;
  readonly category: StripeReconciliationCategory;
  readonly status: StripeReconciliationStatus;
  readonly mode: StripeReconciliationMode;
  readonly currency: string;
  readonly expectedAmount: DecimalLike;
  readonly actualAmount: DecimalLike | null;
  readonly deltaAmount: DecimalLike | null;
  readonly toleranceAmount: DecimalLike;
  readonly stripeTransactionCount: number | null;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly detail: string;
  readonly computedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolvedByUserId: string | null;
  readonly resolutionNotes: string | null;
}

/**
 * Map a persisted reconciliation-check row to its wire DTO (CLAUDE.md §3.3
 * — never return raw Prisma objects). Money columns (`Decimal(12, 2)`)
 * become integer minor units; the `@db.Date` reconciliation date becomes a
 * `YYYY-MM-DD` UTC key; timestamps become ISO-8601.
 */
export function toStripeReconciliationCheckRecord(
  row: StripeReconciliationCheckRow,
): StripeReconciliationCheckRecord {
  return {
    reconciliationDate: utcDayKey(row.reconciliationDate),
    category: row.category,
    status: row.status,
    mode: row.mode,
    currency: row.currency as 'USD',
    expectedAmountMinor: decimalToMinor(aggregateToDecimal(row.expectedAmount)),
    actualAmountMinor:
      row.actualAmount === null ? null : decimalToMinor(aggregateToDecimal(row.actualAmount)),
    deltaAmountMinor:
      row.deltaAmount === null ? null : decimalToMinor(aggregateToDecimal(row.deltaAmount)),
    toleranceAmountMinor: decimalToMinor(aggregateToDecimal(row.toleranceAmount)),
    stripeTransactionCount: row.stripeTransactionCount,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    detail: row.detail,
    computedAt: row.computedAt.toISOString(),
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    resolvedByUserId: row.resolvedByUserId,
    resolutionNotes: row.resolutionNotes,
  };
}
