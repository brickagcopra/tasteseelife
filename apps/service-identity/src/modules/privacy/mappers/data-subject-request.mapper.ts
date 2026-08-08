import type { DataSubjectRequestReceipt, DataSubjectRequestRecord } from '@taste-and-see/contracts';

import type { DataSubjectRequestRow } from '../services/data-subject-requests.service';

/**
 * Row → DTO mappers for data-subject requests (TS-309a; CLAUDE.md §3.3 —
 * never return a raw Prisma object).
 *
 * **Two mappers, and the gap between them is a decision, not an omission.**
 * The receipt is what the REQUESTER sees about their own request; the record
 * is what an operator sees. What the receipt withholds:
 *
 *   - `verificationMethod` — how staff satisfied themselves that the requester
 *     is who they say. Publishing it teaches somebody how to defeat it.
 *   - `note` / `refusalNote` — free text written by people, one of them by
 *     staff about the requester.
 *   - `subjectId` / `requesterUserId` — the requester already knows who they
 *     asked about; echoing ids back adds nothing and widens the surface.
 *
 * What the receipt deliberately KEEPS is `refusalReason`. Being told "no"
 * without being told why is precisely the opacity these laws exist to prevent,
 * and the categorical reason is safe to return — it is a fixed vocabulary
 * chosen for exactly this.
 */

export function toReceipt(row: DataSubjectRequestRow): DataSubjectRequestReceipt {
  return {
    id: row.id,
    kind: row.kind,
    subjectKind: row.subjectKind,
    status: row.status,
    selfService: row.selfService,
    receivedAt: row.receivedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    extendedAt: row.extendedAt?.toISOString() ?? null,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    refusalReason: row.refusalReason,
  };
}

export function toRecord(row: DataSubjectRequestRow): DataSubjectRequestRecord {
  return {
    ...toReceipt(row),
    requesterUserId: row.requesterUserId,
    subjectId: row.subjectId,
    note: row.note,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifiedByUserId: row.verifiedByUserId,
    verificationMethod: row.verificationMethod,
    refusalNote: row.refusalNote,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
  };
}
