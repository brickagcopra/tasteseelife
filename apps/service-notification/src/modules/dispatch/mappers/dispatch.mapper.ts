import type { DispatchResponse, DispatchesListResponse } from '@taste-and-see/contracts';
import { DispatchResponseSchema, DispatchesListResponseSchema } from '@taste-and-see/contracts';

import type { DispatchResult, DispatchRow } from '../services/dispatch-orchestrator.service';

export function toDispatchResponse(result: DispatchResult): DispatchResponse {
  return DispatchResponseSchema.parse({
    id: result.dispatch.id,
    recipientUserId: result.dispatch.recipientUserId,
    channel: result.dispatch.channel,
    category: result.dispatch.category,
    templateCode: result.dispatch.templateCode,
    locale: result.dispatch.locale,
    templateVersionId: result.dispatch.templateVersionId,
    recipientAddress: result.dispatch.recipientAddress,
    status: result.dispatch.status,
    suppressionReason: result.dispatch.suppressionReason,
    providerMessageId: result.dispatch.providerMessageId,
    errorMessage: result.dispatch.errorMessage,
    idempotencyKey: result.dispatch.idempotencyKey,
    sourceEventId: result.dispatch.sourceEventId,
    occurredAt: result.dispatch.occurredAt.toISOString(),
    sentAt: result.dispatch.sentAt ? result.dispatch.sentAt.toISOString() : null,
    replayed: result.replayed,
  });
}

export function toDispatchListResponse(
  rows: DispatchRow[],
  nextCursor: string | null,
): DispatchesListResponse {
  return DispatchesListResponseSchema.parse({
    dispatches: rows.map((row) => toDispatchResponse({ dispatch: row, replayed: false })),
    nextCursor,
  });
}
