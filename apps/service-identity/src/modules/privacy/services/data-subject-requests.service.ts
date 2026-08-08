import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import {
  DATA_SUBJECT_REQUEST_EXTENSION_DAYS,
  DATA_SUBJECT_REQUEST_RESPONSE_DAYS,
  TERMINAL_DATA_SUBJECT_REQUEST_STATUSES,
  canAdvanceDataSubjectRequest,
  type DataSubjectKind,
  type DataSubjectRequestKind,
  type DataSubjectRequestRefusalReason,
  type DataSubjectRequestStatus,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import { PRIVACY_AUDIT_RESOURCE } from '../audit-resources';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The row as every read path projects it. Explicit `select` throughout — the
 * table carries three free-text fields written by people, and a `select`-less
 * read would pull them into memory on surfaces that must not show them
 * (CLAUDE.md §3.9, §4.1).
 */
const REQUEST_SELECT = {
  id: true,
  requesterUserId: true,
  subjectKind: true,
  subjectId: true,
  selfService: true,
  kind: true,
  status: true,
  note: true,
  receivedAt: true,
  dueAt: true,
  extendedAt: true,
  extensionReason: true,
  verifiedAt: true,
  verifiedByUserId: true,
  verificationMethod: true,
  fulfilledAt: true,
  refusedAt: true,
  refusalReason: true,
  refusalNote: true,
  withdrawnAt: true,
} as const;

export interface DataSubjectRequestRow {
  readonly id: string;
  readonly requesterUserId: string;
  readonly subjectKind: DataSubjectKind;
  readonly subjectId: string;
  readonly selfService: boolean;
  readonly kind: DataSubjectRequestKind;
  readonly status: DataSubjectRequestStatus;
  readonly note: string | null;
  readonly receivedAt: Date;
  readonly dueAt: Date;
  readonly extendedAt: Date | null;
  readonly extensionReason: string | null;
  readonly verifiedAt: Date | null;
  readonly verifiedByUserId: string | null;
  readonly verificationMethod: string | null;
  readonly fulfilledAt: Date | null;
  readonly refusedAt: Date | null;
  readonly refusalReason: DataSubjectRequestRefusalReason | null;
  readonly refusalNote: string | null;
  readonly withdrawnAt: Date | null;
}

export interface CreateDataSubjectRequestInput {
  /** Stamped from the verified access token by the controller. Never a body field. */
  readonly requesterUserId: string;
  readonly kind: DataSubjectRequestKind;
  /** Absent means "me" — see `resolveSubject`. */
  readonly subjectKind?: DataSubjectKind;
  readonly subjectId?: string;
  readonly note?: string;
}

/**
 * Data-subject request lifecycle (TS-309a; PRD §11.4; PDD §16.3, §16.4;
 * CLAUDE.md §3.6, §12).
 *
 * **The requester, the subject and the verification are three things.** The
 * original acceptance said "users export their data", true only when the
 * account holder and the data subject coincide — and on this platform they
 * routinely do not. Every method here is written around that: nothing leaves
 * `verifying` without a recorded act, and a request whose subject is not its
 * requester can only be advanced by a human.
 *
 * **`verifying` is a state nothing normally RESTS in, and that is deliberate.**
 * Every request walks `received → verifying → in_progress`, because the
 * property worth guaranteeing is "no request reaches work without passing
 * verification" — and the way to guarantee it is to walk the edge, not to
 * declare it. Self-service walks it inside the intake transaction, attributed
 * to the authenticated session. It becomes a resting state the moment
 * verification is asynchronous (a document to review, a call-back scheduled
 * for tomorrow), which is the likely next shape.
 *
 * **Every transition is audit-emitted INSIDE the transaction** via the shared
 * `@taste-and-see/nest-audit` emitter, so a state change that cannot be
 * audited does not commit (CLAUDE.md §3.6). On a legal-record surface that is
 * load-bearing rather than ceremonial: the audit trail is what a regulator
 * asks for, and "we fulfilled it but there is no record of who decided" is not
 * an answer.
 */
@Injectable()
export class DataSubjectRequestsService {
  private readonly logger = new Logger(DataSubjectRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditEmitter,
  ) {}

  /**
   * File a request.
   *
   * A **self-service** request (the requester asking about their own account)
   * is verified by the authenticated session itself — which, on this service,
   * is the strongest proof of "you are that user" the platform has. The
   * controller requires an MFA-verified session before this is reachable, so
   * the session is not merely a cookie. The walk to `in_progress` happens in
   * the same transaction, and the verification method records what the proof
   * actually was rather than leaving it blank.
   *
   * A request naming **someone else** stops at `verifying` and stays there
   * until a human acts. That is the whole point: a family payer asking for a
   * senior's data is a legitimate request and an unverified one, and the
   * difference between those two facts is where this platform's consent model
   * lives (CLAUDE.md §12).
   */
  async createRequest(
    input: CreateDataSubjectRequestInput,
    actor: AuditActorContext,
    now: Date = new Date(),
  ): Promise<DataSubjectRequestRow> {
    const subject = resolveSubject(input);
    const selfService = subject.kind === 'user' && subject.id === input.requesterUserId;

    // One open request per (requester, subject, kind). A second identical ask
    // is not new information, and letting it through would start a second
    // statutory clock on the same question — which is how a platform ends up
    // missing a deadline it already met.
    const open = await this.prisma.dataSubjectRequest.findFirst({
      where: {
        requesterUserId: input.requesterUserId,
        subjectKind: subject.kind,
        subjectId: subject.id,
        kind: input.kind,
        status: { notIn: [...TERMINAL_DATA_SUBJECT_REQUEST_STATUSES] },
      },
      select: { id: true },
    });
    if (open !== null) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        code: 'duplicate_open_request',
        detail: 'An open request of this kind already exists for this subject.',
      });
    }

    const created = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const row = (await tx.dataSubjectRequest.create({
        data: {
          requesterUserId: input.requesterUserId,
          subjectKind: subject.kind,
          subjectId: subject.id,
          selfService,
          kind: input.kind,
          // `received` always, then walked below — never inserted directly at
          // `in_progress`, so the edge is exercised rather than asserted.
          status: 'received',
          ...(input.note !== undefined ? { note: input.note } : {}),
          receivedAt: now,
          dueAt: addDays(now, DATA_SUBJECT_REQUEST_RESPONSE_DAYS),
        },
        select: REQUEST_SELECT,
      })) as DataSubjectRequestRow;

      await this.emitAudit(tx, actor, 'data_subject_request:file', row.id, null, row);

      if (!selfService) return row;

      assertTransition(row.status, 'verifying');
      assertTransition('verifying', 'in_progress');
      const verified = (await tx.dataSubjectRequest.update({
        where: { id: row.id },
        data: {
          status: 'in_progress',
          verifiedAt: now,
          verifiedByUserId: input.requesterUserId,
          verificationMethod: 'self-service: MFA-verified session for the subject account',
        },
        select: REQUEST_SELECT,
      })) as DataSubjectRequestRow;

      await this.emitAudit(tx, actor, 'data_subject_request:verify', row.id, row, verified);
      return verified;
    });

    // Ids, kinds and the clock only — the requester's `note` names people and
    // never reaches a log line (CLAUDE.md §3.9, §10).
    this.logger.log(
      `identity.data_subject_request.filed ${JSON.stringify({
        requestId: created.id,
        kind: created.kind,
        subjectKind: created.subjectKind,
        selfService: created.selfService,
        status: created.status,
        dueAt: created.dueAt.toISOString(),
      })}`,
    );

    return created;
  }

  /**
   * Staff verification of a request naming someone else.
   *
   * Walks `received → verifying → in_progress` in one act, because that is
   * what actually happened: the operator established the link and the work
   * begins. Both edges are checked so the machine is honoured rather than
   * bypassed.
   *
   * **Refuses a self-service request**, which is already verified — accepting
   * one would let an operator overwrite the session-based verification trail
   * with a weaker human-asserted one.
   */
  async verify(
    id: string,
    method: string,
    actor: AuditActorContext,
    verifierUserId: string,
    now: Date = new Date(),
  ): Promise<DataSubjectRequestRow> {
    return this.transition(id, actor, now, (current) => {
      if (current.selfService) {
        throw conflict(
          'already_verified',
          'A self-service request is verified by the session that filed it.',
        );
      }
      assertTransition(current.status, 'verifying');
      assertTransition('verifying', 'in_progress');
      return {
        action: 'data_subject_request:verify',
        data: {
          status: 'in_progress' as const,
          verifiedAt: now,
          verifiedByUserId: verifierUserId,
          verificationMethod: method,
        },
      };
    });
  }

  /**
   * Refuse a request, with a categorical reason.
   *
   * Reachable from every live state, including `in_progress`: a retention rule
   * or an absent senior consent can surface after work has begun, and the
   * honest answer then is a recorded refusal rather than a request that
   * quietly stops progressing.
   */
  async refuse(
    id: string,
    reason: DataSubjectRequestRefusalReason,
    note: string | undefined,
    actor: AuditActorContext,
    now: Date = new Date(),
  ): Promise<DataSubjectRequestRow> {
    return this.transition(id, actor, now, (current) => {
      assertTransition(current.status, 'refused');
      return {
        action: 'data_subject_request:refuse',
        data: {
          status: 'refused' as const,
          refusedAt: now,
          refusalReason: reason,
          ...(note !== undefined ? { refusalNote: note } : {}),
        },
      };
    });
  }

  /**
   * Take the single permitted extension.
   *
   * An explicit, reasoned, audited act rather than a silent recompute — a
   * deadline that moves without anyone deciding it should is not a deadline.
   * A second attempt is a 409, not a second 45 days.
   */
  async extend(
    id: string,
    reason: string,
    actor: AuditActorContext,
    now: Date = new Date(),
  ): Promise<DataSubjectRequestRow> {
    return this.transition(id, actor, now, (current) => {
      if (current.extendedAt !== null) {
        throw conflict('already_extended', 'This request has already been extended once.');
      }
      if (isTerminal(current.status)) {
        throw conflict('request_closed', 'A closed request cannot be extended.');
      }
      return {
        action: 'data_subject_request:extend',
        data: {
          extendedAt: now,
          extensionReason: reason,
          dueAt: addDays(current.dueAt, DATA_SUBJECT_REQUEST_EXTENSION_DAYS),
        },
      };
    });
  }

  /**
   * Withdraw — the REQUESTER's own act, and only their own.
   *
   * The ownership check is here rather than only at the controller because it
   * is a domain rule: nobody else withdraws your privacy request, including
   * staff. An operator who thinks a request should not proceed refuses it,
   * with a reason, on the record.
   */
  async withdraw(
    id: string,
    requesterUserId: string,
    actor: AuditActorContext,
    now: Date = new Date(),
  ): Promise<DataSubjectRequestRow> {
    return this.transition(id, actor, now, (current) => {
      if (current.requesterUserId !== requesterUserId) {
        // 404, not 403: confirming that someone else's request exists is
        // itself a disclosure on a privacy surface.
        throw notFound();
      }
      assertTransition(current.status, 'withdrawn');
      return {
        action: 'data_subject_request:withdraw',
        data: { status: 'withdrawn' as const, withdrawnAt: now },
      };
    });
  }

  /** The requester's own requests, newest first. */
  async listForRequester(requesterUserId: string): Promise<readonly DataSubjectRequestRow[]> {
    return (await this.prisma.dataSubjectRequest.findMany({
      where: { requesterUserId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
      select: REQUEST_SELECT,
    })) as DataSubjectRequestRow[];
  }

  /**
   * One request the caller filed. **404 rather than 403 when it belongs to
   * someone else** — on a privacy surface, confirming that a given request
   * exists is itself a disclosure.
   */
  async getForRequester(id: string, requesterUserId: string): Promise<DataSubjectRequestRow> {
    const row = await this.findById(id);
    if (row === null || row.requesterUserId !== requesterUserId) throw notFound();
    return row;
  }

  /**
   * The operator queue.
   *
   * `status` absent means every request that is not terminal, expressed as a
   * NOT over the derived terminal set — a whitelist would silently drop a
   * status added later, which on a statutory queue means losing work.
   * Deadline-soonest first, which is what the partial index was cut for.
   */
  async listQueue(filter: {
    readonly status?: DataSubjectRequestStatus | undefined;
    readonly kind?: DataSubjectRequestKind | undefined;
    readonly subjectKind?: DataSubjectKind | undefined;
    readonly limit: number;
  }): Promise<readonly DataSubjectRequestRow[]> {
    return (await this.prisma.dataSubjectRequest.findMany({
      where: {
        ...(filter.status !== undefined
          ? { status: filter.status }
          : { status: { notIn: [...TERMINAL_DATA_SUBJECT_REQUEST_STATUSES] } }),
        ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
        ...(filter.subjectKind !== undefined ? { subjectKind: filter.subjectKind } : {}),
      },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: filter.limit,
      select: REQUEST_SELECT,
    })) as DataSubjectRequestRow[];
  }

  async getById(id: string): Promise<DataSubjectRequestRow> {
    const row = await this.findById(id);
    if (row === null) throw notFound();
    return row;
  }

  private async findById(id: string): Promise<DataSubjectRequestRow | null> {
    return (await this.prisma.dataSubjectRequest.findUnique({
      where: { id },
      select: REQUEST_SELECT,
    })) as DataSubjectRequestRow | null;
  }

  /**
   * The one write path every staff action funnels through.
   *
   * Reads the current row, lets the caller decide what changes (throwing if
   * the change is illegal), then applies the update and the audit event in ONE
   * transaction — so a state change that cannot be audited does not commit.
   * The before/after diff on the audit row is the real projection, not a
   * summary, because a regulator asking "what changed and who changed it" is
   * asking about the row.
   */
  private async transition(
    id: string,
    actor: AuditActorContext,
    _now: Date,
    decide: (current: DataSubjectRequestRow) => {
      readonly action: string;
      readonly data: Record<string, unknown>;
    },
  ): Promise<DataSubjectRequestRow> {
    const current = await this.findById(id);
    if (current === null) throw notFound();

    const { action, data } = decide(current);

    const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const row = (await tx.dataSubjectRequest.update({
        where: { id },
        data,
        select: REQUEST_SELECT,
      })) as DataSubjectRequestRow;
      await this.emitAudit(tx, actor, action, id, current, row);
      return row;
    });

    this.logger.log(
      `identity.${action.replace(':', '.')} ${JSON.stringify({
        requestId: updated.id,
        status: updated.status,
        selfService: updated.selfService,
      })}`,
    );

    return updated;
  }

  private async emitAudit(
    tx: PrismaTransactionClient,
    actor: AuditActorContext,
    action: string,
    resourceId: string,
    before: DataSubjectRequestRow | null,
    after: DataSubjectRequestRow | null,
  ): Promise<void> {
    await this.audit.emit(tx as unknown as OutboxRawExecutor, actor, {
      action,
      resourceKind: PRIVACY_AUDIT_RESOURCE.dataSubjectRequest,
      resourceId,
      before: before === null ? null : auditProjection(before),
      after: after === null ? null : auditProjection(after),
    });
  }
}

/**
 * What the audit diff carries.
 *
 * **The free-text fields are omitted**, and this is the one place that
 * decision has to be made explicitly. The audit stream is replicated to
 * Cassandra and read by more surfaces than this table is; putting a
 * requester's note — which may name a senior and describe their circumstances
 * — into every one of them would spread the PII the record exists to protect.
 * What an audit answers is "who changed what, when, and to what state", and
 * every field below serves that.
 */
function auditProjection(row: DataSubjectRequestRow): Record<string, unknown> {
  return {
    id: row.id,
    requesterUserId: row.requesterUserId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    selfService: row.selfService,
    kind: row.kind,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    extendedAt: row.extendedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifiedByUserId: row.verifiedByUserId,
    fulfilledAt: row.fulfilledAt?.toISOString() ?? null,
    refusedAt: row.refusedAt?.toISOString() ?? null,
    refusalReason: row.refusalReason,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
  };
}

/**
 * Resolve the subject a request is about.
 *
 * **Absent means "me".** The common case is a user asking about their own
 * account, and making them type their own id invites a typo that files a
 * request about a stranger. A body that DOES name a subject is a claim about
 * who the data is about — never an authorisation to receive it; that is what
 * verification is for.
 */
export function resolveSubject(input: CreateDataSubjectRequestInput): {
  readonly kind: DataSubjectKind;
  readonly id: string;
} {
  if (input.subjectKind !== undefined && input.subjectId !== undefined) {
    return { kind: input.subjectKind, id: input.subjectId };
  }
  return { kind: 'user', id: input.requesterUserId };
}

function assertTransition(from: DataSubjectRequestStatus, to: DataSubjectRequestStatus): void {
  if (!canAdvanceDataSubjectRequest(from, to)) {
    throw conflict('illegal_transition', `A request in '${from}' cannot move to '${to}'.`);
  }
}

function isTerminal(status: DataSubjectRequestStatus): boolean {
  return TERMINAL_DATA_SUBJECT_REQUEST_STATUSES.includes(status);
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

function conflict(code: string, detail: string): ConflictException {
  return new ConflictException({
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    code,
    detail,
  });
}

function notFound(): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'data-subject request not found',
  });
}
