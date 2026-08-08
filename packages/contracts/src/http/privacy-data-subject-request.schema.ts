import { z } from 'zod';

/**
 * Data-subject request DTOs (TS-309a; PRD §11.4; PDD §16.3, §16.4;
 * CLAUDE.md §3.6, §12).
 *
 * The record behind a privacy request — CCPA's "right to know" and "right to
 * delete", and the state-law equivalents. TS-309b assembles the export;
 * TS-309c would execute an erasure and is compliance-blocked. This contract is
 * the spine both hang off.
 *
 * **The three things this models that are NOT the same person.** The original
 * acceptance said "users export their data", which is true only when the
 * account holder and the data subject coincide. On this platform they
 * routinely do not: the *senior* is who most of the data is about, and the
 * *family payer* holds the account. So every request carries:
 *
 *   - a **requester** — the authenticated account that asked (stamped from the
 *     access token, never from a body: the whole record is worthless if the
 *     caller can name themselves);
 *   - a **subject** — the person the data is about, which may be that same
 *     user, a senior, or a provider;
 *   - a **verification** — the act that links them, and without which nothing
 *     is ever handed over.
 *
 * When those differ, `SeniorConsent` (service-household — one row per senior,
 * a boolean per surface) governs what a family observer may see at all
 * (CLAUDE.md §12). An export that ignored it would breach the platform's own
 * consent model in the course of satisfying a privacy request, which is close
 * to the worst available outcome. This contract's job is to make that
 * situation REPRESENTABLE BUT NEVER AUTOMATIC: a request whose subject is not
 * its requester cannot leave `verifying` without a human act.
 */

export const DATA_SUBJECT_REQUEST_ID_MAX_LENGTH = 64;
export const DATA_SUBJECT_REQUEST_NOTE_MAX_LENGTH = 2_000;
export const DATA_SUBJECT_REQUEST_QUEUE_LIMIT_DEFAULT = 50;
export const DATA_SUBJECT_REQUEST_QUEUE_LIMIT_MAX = 200;

/**
 * Statutory response window, in days.
 *
 * **CCPA gives a business 45 days to respond, extendable once by a further
 * 45 — and this constant is UNCONFIRMED against the states this platform
 * actually operates in.** State privacy laws diverge (some are 45 days, some
 * are 45 "business" days, some differ by request kind), and which of them bind
 * Taste & See is a legal determination nobody has made. It is named,
 * documented and configurable rather than blocking the record on an answer
 * that has to come from outside engineering — the posture TS-300 took with its
 * SLA budgets and TS-303 took with its jurisdiction kit.
 *
 * The one thing that must NOT happen is a user-facing surface printing this
 * number as a promise before someone with standing confirms it. TS-309d says
 * so in its own entry.
 */
export const DATA_SUBJECT_REQUEST_RESPONSE_DAYS = 45;

/** The single permitted extension, in days. Same caveat as the base window. */
export const DATA_SUBJECT_REQUEST_EXTENSION_DAYS = 45;

/**
 * What the requester is asking for.
 *
 * `erasure` is accepted even though TS-309c cannot execute one: refusing to
 * RECORD a request would be worse than refusing to fulfil it, and a recorded
 * refusal with a categorical reason is most of what a regulator asks to see.
 */
export const DataSubjectRequestKindSchema = z.enum(['access', 'erasure']);
export type DataSubjectRequestKind = z.infer<typeof DataSubjectRequestKindSchema>;

/**
 * Who the data is about.
 *
 * `senior` is separate from `user` because a senior is not necessarily an
 * account: the household directory models seniors as their own records, and
 * they are the subject of most of the platform's sensitive data while often
 * never logging in.
 */
export const DataSubjectKindSchema = z.enum(['user', 'senior', 'provider']);
export type DataSubjectKind = z.infer<typeof DataSubjectKindSchema>;

export const DataSubjectRequestStatusSchema = z.enum([
  'received',
  'verifying',
  'in_progress',
  'fulfilled',
  'refused',
  'withdrawn',
]);
export type DataSubjectRequestStatus = z.infer<typeof DataSubjectRequestStatusSchema>;

/**
 * Why a request was refused.
 *
 * **Categorical and first-class, because "no" is an answer a regulator expects
 * to find recorded** — a request that quietly stops progressing is
 * indistinguishable from one nobody worked. Each value is a refusal the
 * platform can actually justify:
 *
 *   - `identity_not_verified` — the link between requester and subject was
 *     never established. The default failure, and the safe one.
 *   - `not_the_subject` — verification established that the requester has no
 *     standing to act for this subject.
 *   - `subject_consent_absent` — the requester is a family member and the
 *     senior has not consented to share what was asked for (CLAUDE.md §12).
 *     Distinct from `not_the_subject`: the relationship is real, the
 *     permission is not.
 *   - `retention_required` — the records must be kept. **The reason a
 *     retention rule applies is legal reference data this platform does not
 *     author** (TS-303a's precedent), so this value records the outcome, not a
 *     citation, and TS-309c owns the schedule itself.
 *   - `duplicate_request` — an identical open request already exists.
 *   - `out_of_scope` — the request asks for something that is not personal
 *     data about the named subject.
 */
export const DataSubjectRequestRefusalReasonSchema = z.enum([
  'identity_not_verified',
  'not_the_subject',
  'subject_consent_absent',
  'retention_required',
  'duplicate_request',
  'out_of_scope',
]);
export type DataSubjectRequestRefusalReason = z.infer<typeof DataSubjectRequestRefusalReasonSchema>;

/**
 * The legal status machine.
 *
 * Load-bearing edges:
 *   - **Everything passes through `verifying`.** There is no path from
 *     `received` to `in_progress`, because handing over a person's data to
 *     whoever asked for it is an account-takeover payload, not a privacy
 *     feature. Self-service requests still traverse it — they simply verify
 *     immediately and automatically, which keeps ONE path rather than two.
 *   - **`refused` is reachable from every live state**, including
 *     `in_progress`: a retention rule or an absent consent can surface after
 *     work has begun, and the honest answer then is a recorded refusal, not a
 *     stall.
 *   - **`withdrawn` is the requester's own act** and is likewise reachable
 *     from every live state.
 *   - `fulfilled`, `refused` and `withdrawn` are terminal. A new ask is a new
 *     request with its own clock — reopening would silently extend a statutory
 *     deadline, which is the one thing a deadline must not do.
 */
export const DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS: Readonly<
  Record<DataSubjectRequestStatus, readonly DataSubjectRequestStatus[]>
> = Object.freeze({
  received: ['verifying', 'refused', 'withdrawn'],
  verifying: ['in_progress', 'refused', 'withdrawn'],
  in_progress: ['fulfilled', 'refused', 'withdrawn'],
  fulfilled: [],
  refused: [],
  withdrawn: [],
});

/** Every status, for exhaustive iteration in tests and admin filters. */
export const DATA_SUBJECT_REQUEST_STATUSES = Object.freeze(
  Object.keys(DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS) as DataSubjectRequestStatus[],
);

/** Statuses from which no transition exists — derived, never restated. */
export const TERMINAL_DATA_SUBJECT_REQUEST_STATUSES = Object.freeze(
  DATA_SUBJECT_REQUEST_STATUSES.filter(
    (status) => DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS[status].length === 0,
  ),
);

export function canAdvanceDataSubjectRequest(
  from: DataSubjectRequestStatus,
  to: DataSubjectRequestStatus,
): boolean {
  return DATA_SUBJECT_REQUEST_STATUS_TRANSITIONS[from].includes(to);
}

// ─── Field schemas ──────────────────────────────────────────────────────

const IdSchema = z.string().trim().min(1).max(DATA_SUBJECT_REQUEST_ID_MAX_LENGTH);

const NoteSchema = z.string().trim().min(1).max(DATA_SUBJECT_REQUEST_NOTE_MAX_LENGTH);

// ─── Requests ───────────────────────────────────────────────────────────

/**
 * `POST /api/v1/privacy/requests` — file a request.
 *
 * **No `requesterUserId` field, deliberately.** The requester is stamped from
 * the verified access token; accepting it in the body would let a caller file
 * as somebody else, which makes the entire record worthless as evidence. Same
 * rule TS-301b applied to incident reporters.
 *
 * `subjectKind` / `subjectId` are OPTIONAL, and their absence means "me": the
 * common case is a user asking about their own account, and requiring them to
 * name their own id invites a typo that files a request about a stranger. When
 * present, the server still decides whether the requester may act for that
 * subject — the body is a claim, not an authorisation.
 */
export const CreateDataSubjectRequestSchema = z
  .object({
    kind: DataSubjectRequestKindSchema,
    subjectKind: DataSubjectKindSchema.optional(),
    subjectId: IdSchema.optional(),
    /**
     * The requester's own words about what they are asking for. Optional and
     * bounded. Stored, never logged, never carried on an event — it is written
     * by a person and may name anybody.
     */
    note: NoteSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Both or neither. A `subjectId` with no `subjectKind` is an id whose
    // meaning nobody has stated, and a `subjectKind` with no id is a request
    // about an unnamed person — either would land as a silently self-scoped
    // request, which is the wrong default for a body that tried to name
    // someone else.
    const hasKind = value.subjectKind !== undefined;
    const hasId = value.subjectId !== undefined;
    if (hasKind !== hasId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'subjectKind and subjectId must be supplied together',
        path: [hasKind ? 'subjectId' : 'subjectKind'],
      });
    }
  });
export type CreateDataSubjectRequest = z.infer<typeof CreateDataSubjectRequestSchema>;

/** `POST /api/v1/admin/privacy/requests/{id}/verify`. */
export const VerifyDataSubjectRequestSchema = z
  .object({
    /**
     * How the requester's link to the subject was established. Free-ish text
     * because the methods vary (a call-back to a number on file, a document,
     * a household-membership check) and enumerating them today would be
     * guessing. Required: an unexplained verification is not one.
     */
    method: NoteSchema,
  })
  .strict();
export type VerifyDataSubjectRequest = z.infer<typeof VerifyDataSubjectRequestSchema>;

/** `POST /api/v1/admin/privacy/requests/{id}/refuse`. */
export const RefuseDataSubjectRequestSchema = z
  .object({
    reason: DataSubjectRequestRefusalReasonSchema,
    /** Optional detail for the record. Never shown verbatim to the requester. */
    note: NoteSchema.optional(),
  })
  .strict();
export type RefuseDataSubjectRequest = z.infer<typeof RefuseDataSubjectRequestSchema>;

/**
 * `POST /api/v1/admin/privacy/requests/{id}/extend`.
 *
 * The extension is an explicit, audited ACT rather than a silent recompute —
 * a statutory deadline that moves without anyone deciding it should is not a
 * deadline. Permitted once; the service rejects a second.
 */
export const ExtendDataSubjectRequestSchema = z.object({ reason: NoteSchema }).strict();
export type ExtendDataSubjectRequest = z.infer<typeof ExtendDataSubjectRequestSchema>;

// ─── Responses ──────────────────────────────────────────────────────────

/**
 * What the REQUESTER sees about their own request.
 *
 * Deliberately narrower than the operator view: no `verificationMethod` (it
 * describes how staff satisfied themselves, and publishing it teaches someone
 * how to defeat it) and no internal notes. The refusal REASON is included —
 * being told "no" without being told why is exactly the opacity these laws
 * exist to prevent.
 */
export const DataSubjectRequestReceiptSchema = z
  .object({
    id: IdSchema,
    kind: DataSubjectRequestKindSchema,
    subjectKind: DataSubjectKindSchema,
    status: DataSubjectRequestStatusSchema,
    /** True when the requester is the subject — the self-service path. */
    selfService: z.boolean(),
    receivedAt: z.string().datetime({ offset: true }),
    dueAt: z.string().datetime({ offset: true }),
    extendedAt: z.string().datetime({ offset: true }).nullable(),
    fulfilledAt: z.string().datetime({ offset: true }).nullable(),
    refusalReason: DataSubjectRequestRefusalReasonSchema.nullable(),
  })
  .strict();
export type DataSubjectRequestReceipt = z.infer<typeof DataSubjectRequestReceiptSchema>;

/**
 * The full operator view. Adds the requester, the subject id, the
 * verification trail and the free-text notes.
 */
export const DataSubjectRequestRecordSchema = DataSubjectRequestReceiptSchema.extend({
  requesterUserId: IdSchema,
  subjectId: IdSchema,
  note: z.string().nullable(),
  verifiedAt: z.string().datetime({ offset: true }).nullable(),
  verifiedByUserId: IdSchema.nullable(),
  verificationMethod: z.string().nullable(),
  refusalNote: z.string().nullable(),
  withdrawnAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type DataSubjectRequestRecord = z.infer<typeof DataSubjectRequestRecordSchema>;

export const DataSubjectRequestReceiptResponseSchema = z
  .object({ request: DataSubjectRequestReceiptSchema })
  .strict();
export type DataSubjectRequestReceiptResponse = z.infer<
  typeof DataSubjectRequestReceiptResponseSchema
>;

export const DataSubjectRequestListResponseSchema = z
  .object({ requests: z.array(DataSubjectRequestReceiptSchema) })
  .strict();
export type DataSubjectRequestListResponse = z.infer<typeof DataSubjectRequestListResponseSchema>;

export const DataSubjectRequestResponseSchema = z
  .object({ request: DataSubjectRequestRecordSchema })
  .strict();
export type DataSubjectRequestResponse = z.infer<typeof DataSubjectRequestResponseSchema>;

export const AdminDataSubjectRequestListResponseSchema = z
  .object({ requests: z.array(DataSubjectRequestRecordSchema) })
  .strict();
export type AdminDataSubjectRequestListResponse = z.infer<
  typeof AdminDataSubjectRequestListResponseSchema
>;

/**
 * `GET /api/v1/admin/privacy/requests` query.
 *
 * `status` absent returns every request that is not terminal — the queue means
 * live work, the same convention as the incident and mandated-reporter queues.
 * Expressed by the service as a NOT over the derived terminal set, so a status
 * added later is included by default rather than silently dropped.
 */
export const ListDataSubjectRequestsQuerySchema = z
  .object({
    status: DataSubjectRequestStatusSchema.optional(),
    kind: DataSubjectRequestKindSchema.optional(),
    subjectKind: DataSubjectKindSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(DATA_SUBJECT_REQUEST_QUEUE_LIMIT_MAX)
      .default(DATA_SUBJECT_REQUEST_QUEUE_LIMIT_DEFAULT),
  })
  .strict();
export type ListDataSubjectRequestsQuery = z.infer<typeof ListDataSubjectRequestsQuerySchema>;
