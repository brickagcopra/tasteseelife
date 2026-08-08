import type {
  Account,
  AdminJournalDetail,
  AdminJournalLine,
  AdminJournalSummary,
  AdminPausedDeferredRevenueBalance,
  AdminPausedDeferredRevenueResponse,
  AdminPeriodEvent,
  AdminTrialBalanceResponse,
  AdminTrialBalanceRow,
} from '@taste-and-see/contracts';
import Decimal from 'decimal.js';

import type { AdminAccountRow } from '../services/admin-chart-of-accounts.service';
import type {
  PausedBalanceRow,
  PausedBalancesView,
} from '../services/admin-deferred-revenue.service';
import type { AdminJournalLineRow, AdminJournalRow } from '../services/admin-journals.service';
import type { AdminPeriodEventRow } from '../services/admin-period-events.service';
import type { TrialBalanceComputed, TrialBalanceRow } from '../services/trial-balance.service';

interface DecimalLike {
  toString(): string;
}

/**
 * Project a service-internal journal row + lines onto the public list
 * DTO. Strips the embedded `lines` collection (the list view carries
 * only the totals + line count) and projects `Decimal` debit / credit
 * sums to integer minor units.
 */
export function toAdminJournalSummary(row: AdminJournalRow): AdminJournalSummary {
  const { totalDebitMinor, totalCreditMinor, currency } = aggregateLines(row.lines);

  return {
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    postedAt: row.postedAt.toISOString(),
    sourceEventId: row.sourceEventId,
    description: row.description,
    periodId: row.periodId,
    periodName: row.periodName,
    postedByUserId: row.postedByUserId,
    reversedJournalId: row.reversedJournalId,
    reversedByJournalId: row.reversedByJournalId,
    lineCount: row.lines.length,
    totalDebitMinor,
    totalCreditMinor,
    currency,
  };
}

/**
 * Project a service-internal journal row + lines onto the detail DTO.
 * Carries the embedded line collection in canonical order
 * (matches the service's `createdAt ASC` orderBy on the select).
 */
export function toAdminJournalDetail(row: AdminJournalRow): AdminJournalDetail {
  const { totalDebitMinor, totalCreditMinor, currency } = aggregateLines(row.lines);

  return {
    id: row.id,
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    postedAt: row.postedAt.toISOString(),
    sourceEventId: row.sourceEventId,
    description: row.description,
    periodId: row.periodId,
    periodName: row.periodName,
    postedByUserId: row.postedByUserId,
    reversedJournalId: row.reversedJournalId,
    reversedByJournalId: row.reversedByJournalId,
    totalDebitMinor,
    totalCreditMinor,
    currency,
    context: normalizeContext(row.context),
    lines: row.lines.map(toAdminJournalLine),
  };
}

function toAdminJournalLine(line: AdminJournalLineRow): AdminJournalLine {
  return {
    id: line.id,
    accountId: line.accountId,
    accountCode: line.accountCode,
    accountName: line.accountName,
    debitMinor: decimalToMinor(line.debit),
    creditMinor: decimalToMinor(line.credit),
    currency: narrowCurrency(line.currency),
    memo: line.memo,
  };
}

function aggregateLines(lines: readonly AdminJournalLineRow[]): {
  readonly totalDebitMinor: number;
  readonly totalCreditMinor: number;
  readonly currency: 'USD';
} {
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);
  let currency: 'USD' | null = null;
  for (const line of lines) {
    totalDebit = totalDebit.plus(toDecimal(line.debit));
    totalCredit = totalCredit.plus(toDecimal(line.credit));
    const lineCurrency = narrowCurrency(line.currency);
    if (currency === null) {
      currency = lineCurrency;
    } else if (currency !== lineCurrency) {
      // The journal-posting service rejects mixed-currency lines at
      // write time; we trust that invariant and only assert it here.
      throw new Error(
        `admin journal mapper: mixed currency in persisted row (${currency} vs ${lineCurrency})`,
      );
    }
  }
  return {
    totalDebitMinor: Number(totalDebit.mul(100).toFixed(0)),
    totalCreditMinor: Number(totalCredit.mul(100).toFixed(0)),
    currency: currency ?? 'USD',
  };
}

/**
 * Project the service-internal trial-balance row onto the contract row
 * shape. Money fields are already integer minor units (the service
 * does the conversion); only currency narrowing is needed here.
 */
export function toAdminTrialBalanceRow(row: TrialBalanceRow): AdminTrialBalanceRow {
  return {
    accountId: row.accountId,
    accountCode: row.accountCode,
    accountName: row.accountName,
    accountType: row.accountType,
    normalBalance: row.normalBalance,
    debitTotalMinor: row.debitTotalMinor,
    creditTotalMinor: row.creditTotalMinor,
    netDebitMinor: row.netDebitMinor,
    netCreditMinor: row.netCreditMinor,
    currency: row.currency,
  };
}

export function toAdminTrialBalanceResponse(
  computed: TrialBalanceComputed,
): AdminTrialBalanceResponse {
  return {
    rows: computed.rows.map(toAdminTrialBalanceRow),
    totalDebitMinor: computed.totalDebitMinor,
    totalCreditMinor: computed.totalCreditMinor,
    imbalanceMinor: computed.imbalanceMinor,
    currency: computed.currency,
    periodId: computed.periodId,
    periodName: computed.periodName,
  };
}

/**
 * Project a service-internal admin account row onto the public
 * `Account` DTO. Converts the Date columns to ISO-8601 strings and
 * omits `description` when the source column is null (matches
 * `AccountSchema`'s `.optional()` shape).
 */
export function toAdminAccountDto(row: AdminAccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    ...(row.description !== null && { description: row.description }),
    type: row.type,
    parentId: row.parentId,
    normalBalance: row.normalBalance,
    currency: row.currency,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Project a service-internal period-lifecycle row onto the contract
 * DTO. Mirrors the existing `PeriodLifecycleEventResponseSchema` shape
 * one-for-one.
 */
export function toAdminPeriodEvent(row: AdminPeriodEventRow): AdminPeriodEvent {
  return {
    id: row.id,
    periodId: row.periodId,
    periodName: row.periodName,
    kind: row.kind,
    actorUserId: row.actorUserId,
    sourceEventId: row.sourceEventId,
    reasonCode: row.reasonCode,
    description: row.description,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Project the paused deferred-revenue queue onto its wire DTO
 * (TS-042-followup-3b2-followup-2a).
 *
 * The service has already done the money arithmetic in `Decimal` and the
 * age arithmetic against `asOf`; this is date-to-ISO and currency
 * narrowing only. `narrowCurrency` throwing on a non-USD row is the
 * intended Phase-1 behaviour — see the service doc-block on why a stranded
 * balance must break the surface loudly rather than be filtered out of the
 * queue built to find it.
 */
export function toAdminPausedDeferredRevenueResponse(
  view: PausedBalancesView,
): AdminPausedDeferredRevenueResponse {
  return {
    asOf: view.asOf.toISOString(),
    summary: {
      pausedCount: view.summary.pausedCount,
      pastServicePeriodEndCount: view.summary.pastServicePeriodEndCount,
      unknownPausedAtCount: view.summary.unknownPausedAtCount,
      oldestPausedAt: view.summary.oldestPausedAt?.toISOString() ?? null,
      totalRemainingDeferredMinor: view.summary.totalRemainingDeferredMinor,
      currency: 'USD',
    },
    balances: view.balances.map(toAdminPausedDeferredRevenueBalance),
    truncated: view.truncated,
  };
}

function toAdminPausedDeferredRevenueBalance(
  row: PausedBalanceRow,
): AdminPausedDeferredRevenueBalance {
  return {
    balanceId: row.balanceId,
    subscriptionId: row.subscriptionId,
    customerId: row.customerId,
    customerGroup: row.customerGroup,
    planCode: row.planCode,
    currency: narrowCurrency(row.currency),
    pausedAt: row.pausedAt?.toISOString() ?? null,
    pausedForSeconds: row.pausedForSeconds,
    priorPausedSeconds: row.priorPausedSeconds,
    servicePeriodStart: row.servicePeriodStart.toISOString(),
    servicePeriodEnd: row.servicePeriodEnd.toISOString(),
    pastServicePeriodEnd: row.pastServicePeriodEnd,
    originalAmountMinor: row.originalAmountMinor,
    recognizedAmountMinor: row.recognizedAmountMinor,
    remainingDeferredMinor: row.remainingDeferredMinor,
  };
}

function decimalToMinor(value: DecimalLike): number {
  return Number(toDecimal(value).mul(100).toFixed(0));
}

function toDecimal(value: DecimalLike): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value === 'object' && 'toString' in value) {
    return new Decimal((value as { toString(): string }).toString());
  }
  throw new Error(`admin accounting mapper: unexpected non-Decimal value: ${String(value)}`);
}

function narrowCurrency(value: string): 'USD' {
  if (value !== 'USD') {
    throw new Error(`unsupported currency in admin accounting row: ${value}`);
  }
  return 'USD';
}

function normalizeContext(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object') {
    throw new Error(
      `admin accounting mapper: expected context to be a JSON object, got ${typeof value}`,
    );
  }
  return value as Record<string, unknown>;
}
