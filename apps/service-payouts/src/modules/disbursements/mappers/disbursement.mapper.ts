import {
  type IngestPayoutTransferEventResponse,
  IngestPayoutTransferEventResponseSchema,
  type PayoutDisbursementResponse,
  PayoutDisbursementResponseSchema,
  type PayoutDisbursementsListResponse,
  PayoutDisbursementsListResponseSchema,
  type RunDisbursementSweepResponse,
  RunDisbursementSweepResponseSchema,
  type SchedulePayoutDisbursementResponse,
  SchedulePayoutDisbursementResponseSchema,
} from '@taste-and-see/contracts';

import type { DisbursementRecord } from '../services/disbursements.service';
import type { RunSweepResult } from '../services/disbursement-scheduler.service';

/**
 * Domain → wire DTO mappers (CLAUDE.md §3.3). Every mapper parses-via-
 * contract before returning so any drift between the service-layer
 * shape and the wire contract surfaces at the boundary, not at the
 * consumer.
 */
export function toPayoutDisbursementResponse(
  record: DisbursementRecord,
): PayoutDisbursementResponse {
  return PayoutDisbursementResponseSchema.parse({
    id: record.id,
    providerId: record.providerId,
    stripeAccountId: record.stripeAccountId,
    stripeTransferId: record.stripeTransferId,
    currency: record.currency,
    amountMinor: record.amountMinor,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    sourceEventId: record.sourceEventId,
    scheduledFor: formatCalendarDate(record.scheduledFor),
    heldUntil: record.heldUntil.toISOString(),
    initiatedAt: record.initiatedAt === null ? null : record.initiatedAt.toISOString(),
    paidAt: record.paidAt === null ? null : record.paidAt.toISOString(),
    failedAt: record.failedAt === null ? null : record.failedAt.toISOString(),
    failureReason: record.failureReason,
    memo: record.memo,
    liveMode: record.liveMode,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

export function toSchedulePayoutDisbursementResponse(
  outcome: 'created' | 'existing',
  record: DisbursementRecord,
): SchedulePayoutDisbursementResponse {
  return SchedulePayoutDisbursementResponseSchema.parse({
    outcome,
    disbursement: toPayoutDisbursementResponse(record),
  });
}

export function toIngestPayoutTransferEventResponse(
  outcome: 'applied' | 'replayed' | 'ignored',
  record: DisbursementRecord | null,
): IngestPayoutTransferEventResponse {
  return IngestPayoutTransferEventResponseSchema.parse({
    outcome,
    disbursement: record === null ? null : toPayoutDisbursementResponse(record),
  });
}

export function toRunDisbursementSweepResponse(
  result: RunSweepResult,
): RunDisbursementSweepResponse {
  return RunDisbursementSweepResponseSchema.parse({
    asOfDate: result.asOfDate,
    holdDays: result.holdDays,
    minAmountMinor: result.minAmountMinor,
    dryRun: result.dryRun,
    consideredProviderCount: result.consideredProviderCount,
    scheduledCount: result.scheduledCount,
    idempotentExistingCount: result.idempotentExistingCount,
    skippedCount: result.skippedCount,
    totalScheduledAmountMinor: result.totalScheduledAmountMinor,
    currency: result.currency,
    perProvider: result.perProvider.map((entry) => ({ ...entry })),
  });
}

export function toPayoutDisbursementsListResponse(
  records: readonly DisbursementRecord[],
  nextCursor: string | null,
): PayoutDisbursementsListResponse {
  return PayoutDisbursementsListResponseSchema.parse({
    rows: records.map(toPayoutDisbursementResponse),
    nextCursor,
  });
}

function formatCalendarDate(date: Date): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
