import { describe, expect, it } from 'vitest';

import {
  CreateDataSubjectRequestSchema,
  DATA_SUBJECT_REQUEST_EXTENSION_DAYS,
  DATA_SUBJECT_REQUEST_RESPONSE_DAYS,
  DATA_SUBJECT_REQUEST_STATUSES,
  DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS,
  DataSubjectRequestReceiptSchema,
  DataSubjectRequestRecordSchema,
  ExtendDataSubjectRequestSchema,
  ListDataSubjectRequestsQuerySchema,
  RefuseDataSubjectRequestSchema,
  TERMINAL_DATA_SUBJECT_REQUEST_STATUSES,
  VerifyDataSubjectRequestSchema,
  canAdvanceDataSubjectRequest,
} from '../http/privacy-data-subject-request.schema';

/**
 * Contract tests for the data-subject request DTOs (TS-309a).
 *
 * The properties worth pinning are the ones a later change could break
 * without anything else noticing:
 *   - the requester is NEVER accepted from the body;
 *   - there is NO path from `received` straight to `in_progress` — everything
 *     passes through verification, because handing a person's data to whoever
 *     asked is an account-takeover payload;
 *   - `refused` and `withdrawn` are reachable from every live state;
 *   - terminal states are terminal, so a new ask needs a new clock;
 *   - the receipt withholds the verification method while still telling the
 *     requester WHY they were refused.
 */

describe('CreateDataSubjectRequestSchema', () => {
  it('accepts a bare self-service request', () => {
    expect(CreateDataSubjectRequestSchema.safeParse({ kind: 'access' }).success).toBe(true);
  });

  it('accepts a request naming another subject', () => {
    expect(
      CreateDataSubjectRequestSchema.safeParse({
        kind: 'access',
        subjectKind: 'senior',
        subjectId: 'sen_1',
      }).success,
    ).toBe(true);
  });

  it('REJECTS a requesterUserId in the body', () => {
    // The requester is stamped from the verified token. Accepting it here
    // would let a caller file as somebody else, which makes the whole
    // record worthless as evidence.
    expect(
      CreateDataSubjectRequestSchema.safeParse({
        kind: 'access',
        requesterUserId: 'usr_someone_else',
      }).success,
    ).toBe(false);
  });

  it('requires subjectKind and subjectId together', () => {
    // Half a subject would land as a silently self-scoped request — the
    // wrong default for a body that tried to name someone else.
    expect(
      CreateDataSubjectRequestSchema.safeParse({ kind: 'access', subjectId: 'sen_1' }).success,
    ).toBe(false);
    expect(
      CreateDataSubjectRequestSchema.safeParse({ kind: 'access', subjectKind: 'senior' }).success,
    ).toBe(false);
  });

  it('accepts an erasure request even though execution is blocked', () => {
    // Refusing to RECORD one would be worse than refusing to fulfil it.
    expect(CreateDataSubjectRequestSchema.safeParse({ kind: 'erasure' }).success).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(CreateDataSubjectRequestSchema.safeParse({ kind: 'rectification' }).success).toBe(false);
  });
});

describe('DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS', () => {
  it('has NO path from received straight to in_progress', () => {
    // The single most important edge in the machine — or rather, the
    // single most important edge that must not exist.
    expect(canAdvanceDataSubjectRequest('received', 'in_progress')).toBe(false);
  });

  it('routes every live state through verification before work begins', () => {
    expect(canAdvanceDataSubjectRequest('received', 'verifying')).toBe(true);
    expect(canAdvanceDataSubjectRequest('verifying', 'in_progress')).toBe(true);
  });

  it('allows refusal and withdrawal from every live state', () => {
    // A retention rule or an absent consent can surface after work has
    // begun; the honest answer then is a recorded refusal, not a stall.
    for (const status of ['received', 'verifying', 'in_progress'] as const) {
      expect(canAdvanceDataSubjectRequest(status, 'refused')).toBe(true);
      expect(canAdvanceDataSubjectRequest(status, 'withdrawn')).toBe(true);
    }
  });

  it('derives exactly three terminal states, and none of them exits', () => {
    expect([...TERMINAL_DATA_SUBJECT_REQUEST_STATUSES].sort()).toEqual([
      'fulfilled',
      'refused',
      'withdrawn',
    ]);
    for (const status of TERMINAL_DATA_SUBJECT_REQUEST_STATUSES) {
      expect(DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('never allows a terminal request to reopen — a new ask needs a new clock', () => {
    // Reopening would silently extend a statutory deadline, which is the
    // one thing a deadline must not do.
    for (const from of TERMINAL_DATA_SUBJECT_REQUEST_STATUSES) {
      for (const to of DATA_SUBJECT_REQUEST_STATUSES) {
        expect(canAdvanceDataSubjectRequest(from, to)).toBe(false);
      }
    }
  });

  it('declares a transition list for every status', () => {
    for (const status of DATA_SUBJECT_REQUEST_STATUSES) {
      expect(Array.isArray(DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS[status])).toBe(true);
    }
  });

  it('never lists a status as its own successor', () => {
    for (const status of DATA_SUBJECT_REQUEST_STATUSES) {
      expect(DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS[status]).not.toContain(status);
    }
  });
});

describe('DataSubjectRequestReceiptSchema', () => {
  const receipt = {
    id: 'dsr_1',
    kind: 'access' as const,
    subjectKind: 'user' as const,
    status: 'verifying' as const,
    selfService: true,
    receivedAt: '2026-07-26T12:00:00.000Z',
    dueAt: '2026-09-09T12:00:00.000Z',
    extendedAt: null,
    fulfilledAt: null,
    refusalReason: null,
  };

  it('accepts a well-formed receipt', () => {
    expect(DataSubjectRequestReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it('tells the requester WHY they were refused', () => {
    // Being told "no" without being told why is exactly the opacity these
    // laws exist to prevent.
    expect(
      DataSubjectRequestReceiptSchema.safeParse({
        ...receipt,
        status: 'refused',
        refusalReason: 'retention_required',
      }).success,
    ).toBe(true);
  });

  it('WITHHOLDS the verification method and the internal notes', () => {
    // How staff satisfied themselves is not the requester's business —
    // publishing it teaches someone how to defeat it.
    for (const field of ['verificationMethod', 'refusalNote', 'note', 'requesterUserId']) {
      expect(DataSubjectRequestReceiptSchema.safeParse({ ...receipt, [field]: 'x' }).success).toBe(
        false,
      );
    }
  });

  it('withholds the subject id — the requester already knows who they asked about', () => {
    expect(
      DataSubjectRequestReceiptSchema.safeParse({ ...receipt, subjectId: 'sen_1' }).success,
    ).toBe(false);
  });

  it('is a strict subset of the operator record', () => {
    const receiptKeys = Object.keys(DataSubjectRequestReceiptSchema.shape);
    const recordKeys = Object.keys(DataSubjectRequestRecordSchema.shape);

    expect(receiptKeys.every((key) => recordKeys.includes(key))).toBe(true);
    expect(recordKeys.length).toBeGreaterThan(receiptKeys.length);
  });
});

describe('staff action payloads', () => {
  it('requires an explanation on verification — an unexplained one is not one', () => {
    expect(VerifyDataSubjectRequestSchema.safeParse({}).success).toBe(false);
    expect(
      VerifyDataSubjectRequestSchema.safeParse({ method: 'call-back to the number on file' })
        .success,
    ).toBe(true);
  });

  it('requires a categorical refusal reason, not just prose', () => {
    expect(RefuseDataSubjectRequestSchema.safeParse({ note: 'we decided not to' }).success).toBe(
      false,
    );
    expect(RefuseDataSubjectRequestSchema.safeParse({ reason: 'retention_required' }).success).toBe(
      true,
    );
  });

  it('requires a reason to extend — a deadline that moves without a decision is not one', () => {
    expect(ExtendDataSubjectRequestSchema.safeParse({}).success).toBe(false);
    expect(
      ExtendDataSubjectRequestSchema.safeParse({ reason: 'awaiting a partner export' }).success,
    ).toBe(true);
  });
});

describe('ListDataSubjectRequestsQuerySchema', () => {
  it('defaults the limit and leaves every filter undefined', () => {
    const parsed = ListDataSubjectRequestsQuerySchema.parse({});

    expect(parsed.limit).toBe(50);
    expect(parsed.status).toBeUndefined();
    expect(parsed.kind).toBeUndefined();
  });

  it('rejects a limit above the cap', () => {
    expect(ListDataSubjectRequestsQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});

describe('statutory window constants', () => {
  it('carries CCPA’s 45-day window and its single 45-day extension', () => {
    expect(DATA_SUBJECT_REQUEST_RESPONSE_DAYS).toBe(45);
    expect(DATA_SUBJECT_REQUEST_EXTENSION_DAYS).toBe(45);
  });
});
