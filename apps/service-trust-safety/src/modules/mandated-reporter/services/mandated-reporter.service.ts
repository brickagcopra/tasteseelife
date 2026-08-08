import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { TRUST_SAFETY_AUDIT_RESOURCE } from '../../audit/audit-resources';
import {
  canTransition,
  isUsJurisdictionCode,
  MANDATED_REPORTER_TERMINAL_STATUS,
  type MandatedReporterCaseStatus,
} from '../mandated-reporter-enums';
import {
  MandatedReporterRepository,
  type JurisdictionRow,
  type MandatedReporterCaseRow,
  type MandatedReporterCaseSummaryRow,
  type UpsertJurisdictionData,
} from '../repositories/mandated-reporter.repository';

const MS_PER_HOUR = 60 * 60 * 1000;

export interface OpenCaseInput {
  readonly incidentId: string;
  /** USPS code for the senior's state of residence, as recorded by the operator. */
  readonly stateCode: string;
  /** Verified `userId` of the operator opening the case — never a request body value. */
  readonly openedByUserId: string;
  /** Optional opening assessment. PHI/PII — persisted, never logged or emitted. */
  readonly determinationNotes?: string;
  /**
   * Audit actor + request metadata. REQUIRED, not optional: every mutation on
   * this surface is a legal record, so "unaudited mutation" is deliberately
   * unrepresentable in the input type (CLAUDE.md §3.6). A future non-HTTP
   * caller — a system escalation opening a case off an event — constructs a
   * system actor context explicitly rather than passing nothing.
   */
  readonly audit: AuditActorContext;
}

export interface AdvanceCaseInput {
  readonly caseId: string;
  readonly to: MandatedReporterCaseStatus;
  /** Verified `userId` of the operator performing the transition. */
  readonly actorUserId: string;
  readonly determinationNotes?: string;
  /** Agency confirmation / case number. Required on the `filed` transition. */
  readonly filingReference?: string;
  readonly reviewerNotes?: string;
  /** See {@link OpenCaseInput.audit} — required for the same reason. */
  readonly audit: AuditActorContext;
}

/**
 * Audit snapshot of a case. Deliberately omits `determinationNotes` /
 * `reviewerNotes`: those are PHI-bearing free text about a named senior, and
 * copying them into the audit store — a second durable system with its own
 * retention and its own read surface — widens the blast radius for no audit
 * value. The audit row proves WHO changed WHAT and WHEN; the notes stay on
 * the case row for anyone authorised to read them (CLAUDE.md §3.9).
 */
function auditSnapshot(row: MandatedReporterCaseRow): Record<string, unknown> {
  return {
    id: row.id,
    incidentId: row.incidentId,
    stateCode: row.stateCode,
    status: row.status,
    openedByUserId: row.openedByUserId,
    openedAt: row.openedAt.toISOString(),
    statutoryDueAt: row.statutoryDueAt?.toISOString() ?? null,
    filedAt: row.filedAt?.toISOString() ?? null,
    filingReference: row.filingReference,
    reviewerUserId: row.reviewerUserId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
  };
}

/**
 * The mandated-reporter pathway for suspected elder abuse (PRD §10.14,
 * §11.4; PDD §16.1, §16.4; CLAUDE.md §12).
 *
 * Three rules carry this service, and each exists because the failure it
 * prevents is worse than the friction it adds:
 *
 * 1. **Never auto-close.** `assertIncidentResolvable` refuses to let an
 *    incident with a live case resolve. Every incident-resolution path MUST
 *    call it. Only a reviewer signoff releases the block.
 *
 * 2. **No filing prep against an unverified jurisdiction.** The per-state kit
 *    ships empty and unverified on purpose (see the model doc-block): the
 *    platform does not author elder-abuse reporting law. Advancing to
 *    `filing_prep` in a state whose row compliance has not reviewed would
 *    mean assembling a filing against an agency, hotline, and deadline that
 *    nobody checked. The workflow stops instead, loudly.
 *
 * 3. **Four eyes on the determination.** The reviewer signing off may not be
 *    the operator who opened the case — enforced here AND by a CHECK
 *    constraint, because a service-layer-only check leaves a direct UPDATE
 *    able to unblock an elder-abuse incident.
 *
 * The case row's existence is itself the "suspected abuse" tag; nothing is
 * derived from category or severity. See the model doc-block for why.
 *
 * Observability: one info log per transition carrying ids, states, and the
 * jurisdiction code — never `determinationNotes` / `reviewerNotes`, which are
 * PHI-bearing free text (CLAUDE.md §3.9, §10).
 */
@Injectable()
export class MandatedReporterService {
  private readonly logger = new Logger(MandatedReporterService.name);

  constructor(
    private readonly repository: MandatedReporterRepository,
    private readonly audit: AuditEmitter,
  ) {}

  /**
   * Route an incident into the statutory pathway. Idempotent by construction:
   * `mandated_reporter_cases.incident_id` is UNIQUE, so a retry returns the
   * existing case rather than starting a second statutory clock on the same
   * facts.
   *
   * @param now injectable clock (CLAUDE.md §9.3 — deterministic tests).
   */
  async openCase(input: OpenCaseInput, now: Date = new Date()): Promise<MandatedReporterCaseRow> {
    const stateCode = normaliseStateCode(input.stateCode);

    const existing = await this.repository.findCaseByIncidentId(input.incidentId);
    if (existing !== null) {
      // Not an error: the operator (or a retry) asked for something already
      // true. Returning the case keeps the caller's flow linear.
      return existing;
    }

    // The jurisdiction row must EXIST, but need not be verified — opening a
    // case is the act of starting the clock and must never be blocked by our
    // own compliance backlog. It is the *filing prep* step that requires
    // verification.
    const jurisdiction = await this.requireJurisdiction(stateCode);

    const statutoryDueAt = computeStatutoryDueAt(jurisdiction, now);

    const created = await this.repository.insertCase(
      {
        incidentId: input.incidentId,
        stateCode,
        openedByUserId: input.openedByUserId,
        openedAt: now,
        statutoryDueAt,
        determinationNotes: input.determinationNotes ?? null,
      },
      // In-tx audit emission (CLAUDE.md §3.6, §5.3): the record of who
      // classified this incident as suspected abuse commits atomically with
      // the classification, or the classification does not happen.
      (tx, row) =>
        this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: 'trust_safety_mandated_reporter_case:open',
          resourceKind: TRUST_SAFETY_AUDIT_RESOURCE.mandatedReporterCase,
          resourceId: row.id,
          before: null,
          after: auditSnapshot(row),
        }),
    );

    this.logger.log(
      `trust_safety.mandated_reporter.case_opened ${JSON.stringify({
        caseId: created.id,
        incidentId: created.incidentId,
        stateCode: created.stateCode,
        jurisdictionVerified: jurisdiction.verified,
        platformRole: jurisdiction.platformRole,
        statutoryDueAt: created.statutoryDueAt?.toISOString() ?? null,
        openedByUserId: created.openedByUserId,
      })}`,
    );

    if (!jurisdiction.verified) {
      // Loud, not silent. The case is open and the clock is running, but the
      // workflow cannot reach `filing_prep` until compliance populates this
      // state — and somebody needs to know that now, not at the deadline.
      this.logger.warn(
        `trust_safety.mandated_reporter.unverified_jurisdiction ${JSON.stringify({
          caseId: created.id,
          stateCode,
        })}`,
      );
    }

    return created;
  }

  /**
   * Apply a status transition. Rejects illegal transitions, filing prep
   * against an unverified jurisdiction, a filing without a reference, and a
   * self-signoff. Lost compare-and-swap races surface as a conflict rather
   * than silently overwriting the other operator's decision.
   */
  async advance(input: AdvanceCaseInput, now: Date = new Date()): Promise<MandatedReporterCaseRow> {
    const current = await this.requireCase(input.caseId);

    if (!canTransition(current.status, input.to)) {
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `mandated-reporter case cannot move from '${current.status}' to '${input.to}'`,
      });
    }

    if (input.to === 'filing_prep') {
      await this.requireVerifiedJurisdiction(current.stateCode);
    }

    if (input.to === 'filed' && !hasText(input.filingReference)) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'filingReference is required when recording a filing',
      });
    }

    if (input.to === MANDATED_REPORTER_TERMINAL_STATUS) {
      if (input.actorUserId === current.openedByUserId) {
        throw new ConflictException({
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail:
            'reviewer signoff must be performed by someone other than the operator who opened the case',
        });
      }
    }

    const updated = await this.repository.updateCase(
      current.id,
      current.status,
      {
        status: input.to,
        ...(input.determinationNotes !== undefined
          ? { determinationNotes: input.determinationNotes }
          : {}),
        ...(input.to === 'filed'
          ? { filedAt: now, filingReference: input.filingReference ?? null }
          : {}),
        ...(input.to === MANDATED_REPORTER_TERMINAL_STATUS
          ? {
              reviewerUserId: input.actorUserId,
              reviewedAt: now,
              ...(input.reviewerNotes !== undefined ? { reviewerNotes: input.reviewerNotes } : {}),
            }
          : {}),
      },
      (tx, row) =>
        this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: `trust_safety_mandated_reporter_case:${input.to}`,
          resourceKind: TRUST_SAFETY_AUDIT_RESOURCE.mandatedReporterCase,
          resourceId: row.id,
          before: auditSnapshot(current),
          after: auditSnapshot(row),
        }),
    );

    if (updated === null) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'mandated-reporter case changed state concurrently; re-read and retry',
      });
    }

    this.logger.log(
      `trust_safety.mandated_reporter.case_transitioned ${JSON.stringify({
        caseId: updated.id,
        incidentId: updated.incidentId,
        stateCode: updated.stateCode,
        from: current.status,
        to: updated.status,
        actorUserId: input.actorUserId,
      })}`,
    );

    return updated;
  }

  // ─── Jurisdiction kit (TS-303c1) ──────────────────────────────────────

  /** The kit, or just the compliance backlog when `unverifiedOnly`. */
  async listJurisdictions(unverifiedOnly = false): Promise<JurisdictionRow[]> {
    return this.repository.listJurisdictions(unverifiedOnly);
  }

  async getJurisdiction(stateCode: string): Promise<JurisdictionRow> {
    return this.requireJurisdiction(normaliseStateCode(stateCode));
  }

  /**
   * Create or edit a state's kit.
   *
   * **Editing a verified row clears its verification.** The attestation says
   * "compliance checked THESE values against primary sources"; the moment any
   * of them changes it no longer covers what is stored, and leaving the flag
   * set would let an unreviewed hotline number pass the `filing_prep` gate on
   * the strength of a review of the number it replaced. Clearing forces a
   * fresh, attributed attestation — which is a second person's deliberate act,
   * not a checkbox that survived an edit.
   *
   * A no-op edit (every supplied field already equal) does NOT clear it, so
   * re-saving an unchanged form does not knock a state out of service.
   */
  async upsertJurisdiction(
    input: {
      readonly stateCode: string;
      readonly changes: UpsertJurisdictionData;
      readonly audit: AuditActorContext;
    },
    now: Date = new Date(),
  ): Promise<JurisdictionRow> {
    const stateCode = normaliseStateCode(input.stateCode);
    const before = await this.repository.findJurisdiction(stateCode);

    const substantive = pickSubstantive(input.changes);
    const invalidates = before !== null && before.verified && changesAnyValue(before, substantive);

    const data: UpsertJurisdictionData = invalidates
      ? { ...input.changes, verified: false, verifiedAt: null, verifiedByUserId: null }
      : input.changes;

    const saved = await this.repository.upsertJurisdiction(stateCode, data, (tx, row) =>
      this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
        action: 'trust_safety_mandated_reporter_jurisdiction:upsert',
        resourceKind: TRUST_SAFETY_AUDIT_RESOURCE.mandatedReporterJurisdiction,
        resourceId: row.stateCode,
        before: before === null ? null : jurisdictionSnapshot(before),
        after: jurisdictionSnapshot(row),
      }),
    );

    if (invalidates) {
      this.logger.warn(
        `trust_safety.mandated_reporter.verification_invalidated ${JSON.stringify({
          stateCode,
          actorUserId: input.audit.actorUserId,
        })}`,
      );
    }
    this.logger.log(
      `trust_safety.mandated_reporter.jurisdiction_saved ${JSON.stringify({
        stateCode,
        verified: saved.verified,
        platformRole: saved.platformRole,
        created: before === null,
        actorUserId: input.audit.actorUserId,
      })}`,
    );

    // `now` participates only through the verification path; referenced here
    // so the signature stays uniform with the other mutators.
    void now;
    return saved;
  }

  /**
   * Record or withdraw compliance's attestation that a state's kit matches
   * counsel-reviewed sources.
   *
   * Withdrawal is first-class: reporting law changes by legislative session,
   * and a state whose statute has moved must be pulled out of service —
   * blocking filing prep — rather than left asserting a stale window.
   */
  async setJurisdictionVerification(
    input: {
      readonly stateCode: string;
      readonly verified: boolean;
      readonly notes?: string | null;
      readonly audit: AuditActorContext;
    },
    now: Date = new Date(),
  ): Promise<JurisdictionRow> {
    const stateCode = normaliseStateCode(input.stateCode);
    const before = await this.requireJurisdiction(stateCode);

    const saved = await this.repository.setJurisdictionVerification(
      stateCode,
      {
        verified: input.verified,
        // Attribution is written with the flag; the DB CHECK rejects a
        // verified row without it, so the two cannot drift.
        verifiedAt: input.verified ? now : null,
        verifiedByUserId: input.verified ? input.audit.actorUserId : null,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      (tx, row) =>
        this.audit.emit(tx as unknown as OutboxRawExecutor, input.audit, {
          action: input.verified
            ? 'trust_safety_mandated_reporter_jurisdiction:verify'
            : 'trust_safety_mandated_reporter_jurisdiction:unverify',
          resourceKind: TRUST_SAFETY_AUDIT_RESOURCE.mandatedReporterJurisdiction,
          resourceId: row.stateCode,
          before: jurisdictionSnapshot(before),
          after: jurisdictionSnapshot(row),
        }),
    );

    this.logger[input.verified ? 'log' : 'warn'](
      `trust_safety.mandated_reporter.jurisdiction_verification_set ${JSON.stringify({
        stateCode,
        verified: saved.verified,
        actorUserId: input.audit.actorUserId,
      })}`,
    );

    return saved;
  }

  /** The case for an incident, or null when triage never routed it here. */
  async getCaseForIncident(incidentId: string): Promise<MandatedReporterCaseRow | null> {
    return this.repository.findCaseByIncidentId(incidentId);
  }

  /**
   * The operator queue (TS-303c2a). `status` absent means every non-terminal
   * case — the queue is live statutory work.
   *
   * `stateCode` is normalised (and rejected when it is not a real US
   * jurisdiction) rather than passed through: an unrecognised code would
   * silently match nothing, and "the queue is empty" is the most dangerous
   * wrong answer this surface can give.
   */
  async listCases(query: {
    readonly status?: MandatedReporterCaseStatus | undefined;
    readonly stateCode?: string | undefined;
    readonly limit: number;
  }): Promise<MandatedReporterCaseSummaryRow[]> {
    return this.repository.listCases({
      status: query.status,
      stateCode: query.stateCode === undefined ? undefined : normaliseStateCode(query.stateCode),
      limit: query.limit,
    });
  }

  /**
   * **The never-auto-close gate (CLAUDE.md §12).** Every path that resolves
   * an incident must call this first — the ops resolution surface (TS-303b),
   * any bulk/sweep job, and any future automated closure.
   *
   * Throws when a mandated-reporter case exists and has not been signed off.
   * A no-op when the incident was never routed into the pathway, so callers
   * can invoke it unconditionally.
   */
  async assertIncidentResolvable(incidentId: string): Promise<void> {
    const existing = await this.repository.findCaseByIncidentId(incidentId);
    if (existing === null) return;
    if (existing.status === MANDATED_REPORTER_TERMINAL_STATUS) return;

    this.logger.warn(
      `trust_safety.mandated_reporter.resolution_blocked ${JSON.stringify({
        incidentId,
        caseId: existing.id,
        caseStatus: existing.status,
      })}`,
    );

    throw new ConflictException({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail:
        'incident has an open mandated-reporter case and cannot be resolved until a reviewer signs off',
    });
  }

  private async requireCase(caseId: string): Promise<MandatedReporterCaseRow> {
    const found = await this.repository.findCaseById(caseId);
    if (found === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'mandated-reporter case not found',
      });
    }
    return found;
  }

  private async requireJurisdiction(stateCode: string): Promise<JurisdictionRow> {
    const jurisdiction = await this.repository.findJurisdiction(stateCode);
    if (jurisdiction === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: `no mandated-reporter jurisdiction kit exists for '${stateCode}'`,
      });
    }
    return jurisdiction;
  }

  private async requireVerifiedJurisdiction(stateCode: string): Promise<JurisdictionRow> {
    const jurisdiction = await this.requireJurisdiction(stateCode);
    if (!jurisdiction.verified) {
      this.logger.error(
        `trust_safety.mandated_reporter.filing_prep_blocked ${JSON.stringify({ stateCode })}`,
      );
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `the mandated-reporter kit for '${stateCode}' has not been verified by compliance; filing preparation is blocked until it is`,
      });
    }
    return jurisdiction;
  }
}

/**
 * `opened_at` + the jurisdiction's statutory window. Null when the state's
 * deadline is not yet established — an absent deadline is recorded as absent
 * rather than defaulted, because a made-up window on this surface is worse
 * than a visibly missing one.
 */
function computeStatutoryDueAt(jurisdiction: JurisdictionRow, openedAt: Date): Date | null {
  const hours = jurisdiction.statutoryDeadlineHours;
  if (hours === null) return null;
  return new Date(openedAt.getTime() + hours * MS_PER_HOUR);
}

/**
 * Audit snapshot of a jurisdiction row. Unlike the case snapshot this keeps
 * every field: the whole point of auditing the kit is to be able to answer
 * "what did this state's row say on the day that case was filed", and the
 * content is published agency information, not PHI.
 */
function jurisdictionSnapshot(row: JurisdictionRow): Record<string, unknown> {
  return {
    stateCode: row.stateCode,
    agencyName: row.agencyName,
    reportingPhone: row.reportingPhone,
    reportingUrl: row.reportingUrl,
    statutoryDeadlineHours: row.statutoryDeadlineHours,
    platformRole: row.platformRole,
    statuteCitation: row.statuteCitation,
    verified: row.verified,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifiedByUserId: row.verifiedByUserId,
  };
}

/** The fields whose change invalidates an attestation. `notes` is excluded — */
/** working notes are commentary about the row, not a claim the review covered. */
const SUBSTANTIVE_JURISDICTION_FIELDS = [
  'agencyName',
  'reportingPhone',
  'reportingUrl',
  'statutoryDeadlineHours',
  'platformRole',
  'statuteCitation',
] as const;

type SubstantiveField = (typeof SUBSTANTIVE_JURISDICTION_FIELDS)[number];

function pickSubstantive(
  changes: UpsertJurisdictionData,
): Partial<Record<SubstantiveField, unknown>> {
  const picked: Partial<Record<SubstantiveField, unknown>> = {};
  for (const field of SUBSTANTIVE_JURISDICTION_FIELDS) {
    if (changes[field] !== undefined) picked[field] = changes[field];
  }
  return picked;
}

/** True when any supplied substantive field differs from what is stored. */
function changesAnyValue(
  before: JurisdictionRow,
  supplied: Partial<Record<SubstantiveField, unknown>>,
): boolean {
  for (const [field, value] of Object.entries(supplied)) {
    if (before[field as SubstantiveField] !== value) return true;
  }
  return false;
}

function normaliseStateCode(value: string): string {
  const upper = value.trim().toUpperCase();
  if (!isUsJurisdictionCode(upper)) {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: `'${value}' is not a US state or territory code`,
    });
  }
  return upper;
}

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
