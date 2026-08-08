import { Injectable } from '@nestjs/common';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import {
  MANDATED_REPORTER_TERMINAL_STATUS,
  type MandatedReporterCaseStatus,
  type MandatedReporterPlatformRole,
} from '../mandated-reporter-enums';

/**
 * Explicit projections for every read/write (CLAUDE.md §4.1 — no `SELECT *`
 * in production paths).
 */
const JURISDICTION_SELECT = {
  stateCode: true,
  agencyName: true,
  reportingPhone: true,
  reportingUrl: true,
  statutoryDeadlineHours: true,
  platformRole: true,
  statuteCitation: true,
  verified: true,
  verifiedAt: true,
  verifiedByUserId: true,
  notes: true,
} as const;

const CASE_SELECT = {
  id: true,
  incidentId: true,
  stateCode: true,
  status: true,
  openedByUserId: true,
  openedAt: true,
  statutoryDueAt: true,
  filedAt: true,
  filingReference: true,
  determinationNotes: true,
  reviewerUserId: true,
  reviewedAt: true,
  reviewerNotes: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Queue projection (TS-303c2a). `determinationNotes` / `reviewerNotes` are
 * absent BY DESIGN, and the absence is enforced here at the SQL level rather
 * than trimmed in a mapper: the PHI-bearing narrative about a named senior
 * never leaves Postgres for a list read at all (CLAUDE.md §3.9, §4.1).
 */
const CASE_SUMMARY_SELECT = {
  id: true,
  incidentId: true,
  stateCode: true,
  status: true,
  openedByUserId: true,
  openedAt: true,
  statutoryDueAt: true,
  filedAt: true,
  filingReference: true,
  reviewerUserId: true,
  reviewedAt: true,
} as const;

export interface JurisdictionRow {
  readonly stateCode: string;
  readonly agencyName: string | null;
  readonly reportingPhone: string | null;
  readonly reportingUrl: string | null;
  readonly statutoryDeadlineHours: number | null;
  readonly platformRole: MandatedReporterPlatformRole;
  readonly statuteCitation: string | null;
  readonly verified: boolean;
  readonly verifiedAt: Date | null;
  readonly verifiedByUserId: string | null;
  readonly notes: string | null;
}

export interface MandatedReporterCaseRow {
  readonly id: string;
  readonly incidentId: string;
  readonly stateCode: string;
  readonly status: MandatedReporterCaseStatus;
  readonly openedByUserId: string;
  readonly openedAt: Date;
  readonly statutoryDueAt: Date | null;
  readonly filedAt: Date | null;
  readonly filingReference: string | null;
  /** PHI/PII by nature — authorised ops reads only; never on events or logs. */
  readonly determinationNotes: string | null;
  readonly reviewerUserId: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewerNotes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A queue row — {@link MandatedReporterCaseRow} minus the two PHI-bearing
 * notes fields and the row timestamps the operator does not triage on.
 */
export type MandatedReporterCaseSummaryRow = Omit<
  MandatedReporterCaseRow,
  'determinationNotes' | 'reviewerNotes' | 'createdAt' | 'updatedAt'
>;

/**
 * Editable kit fields. `verified` / `verifiedAt` / `verifiedByUserId` are
 * absent by design — attestation moves only through
 * `setJurisdictionVerification`, EXCEPT that the service may clear all three
 * here when an edit invalidates an existing attestation.
 */
export interface UpsertJurisdictionData {
  readonly agencyName?: string | null | undefined;
  readonly reportingPhone?: string | null | undefined;
  readonly reportingUrl?: string | null | undefined;
  readonly statutoryDeadlineHours?: number | null | undefined;
  readonly platformRole?: MandatedReporterPlatformRole | undefined;
  readonly statuteCitation?: string | null | undefined;
  readonly notes?: string | null | undefined;
  /** Set only on the attestation-invalidating path — see the service. */
  readonly verified?: boolean | undefined;
  readonly verifiedAt?: Date | null | undefined;
  readonly verifiedByUserId?: string | null | undefined;
}

export interface SetJurisdictionVerificationData {
  readonly verified: boolean;
  readonly verifiedAt: Date | null;
  readonly verifiedByUserId: string | null;
  readonly notes?: string | null;
}

/**
 * Case-queue filter (TS-303c2a). `status` absent means "every non-terminal
 * case" — see `listCases`.
 */
export interface ListMandatedReporterCasesFilter {
  readonly status?: MandatedReporterCaseStatus | undefined;
  readonly stateCode?: string | undefined;
  readonly limit: number;
}

export interface InsertMandatedReporterCaseData {
  readonly incidentId: string;
  readonly stateCode: string;
  readonly openedByUserId: string;
  readonly openedAt: Date;
  readonly statutoryDueAt: Date | null;
  readonly determinationNotes: string | null;
}

/**
 * Fields a status transition may write. Every one is optional because the
 * legal transitions carry different payloads (a filing carries a reference,
 * a signoff carries a reviewer) — the service layer decides which apply and
 * the DB CHECK constraints backstop the combinations.
 */
export interface UpdateMandatedReporterCaseData {
  readonly status: MandatedReporterCaseStatus;
  readonly statutoryDueAt?: Date | null;
  readonly filedAt?: Date | null;
  readonly filingReference?: string | null;
  readonly determinationNotes?: string | null;
  readonly reviewerUserId?: string | null;
  readonly reviewedAt?: Date | null;
  readonly reviewerNotes?: string | null;
}

/**
 * Persistence for the mandated-reporter workflow (TS-303a). Repositories own
 * persistence; the service owns the domain rules (transition legality, the
 * verified-jurisdiction gate, the signoff invariant) — CLAUDE.md §2.3.
 *
 * `MandatedReporterJurisdiction` is platform-wide reference data and is
 * registered in the tenant-scope SDK's `unscopedModels`; `MandatedReporterCase`
 * is tenant-scoped like the incident it hangs off.
 */
@Injectable()
export class MandatedReporterRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findJurisdiction(stateCode: string): Promise<JurisdictionRow | null> {
    return this.prisma.mandatedReporterJurisdiction.findUnique({
      where: { stateCode },
      select: JURISDICTION_SELECT,
    });
  }

  /**
   * The kit, ordered by state code. `unverifiedOnly` serves the compliance
   * backlog scroll — the states where the workflow is not usable yet — and
   * hits the partial index materialised in the TS-303a migration.
   *
   * Unbounded on purpose: the domain has exactly 56 rows and always will
   * (50 states + DC + 5 territories), so paginating it would be ceremony
   * around a fixed-size lookup table.
   */
  async listJurisdictions(unverifiedOnly: boolean): Promise<JurisdictionRow[]> {
    return this.prisma.mandatedReporterJurisdiction.findMany({
      ...(unverifiedOnly ? { where: { verified: false } } : {}),
      orderBy: { stateCode: 'asc' },
      select: JURISDICTION_SELECT,
    });
  }

  /**
   * Create or edit a state's kit. `verified` is never written here — see
   * `setJurisdictionVerification`. The service decides whether an edit clears
   * an existing attestation and passes the cleared values in `data`.
   */
  async upsertJurisdiction(
    stateCode: string,
    data: UpsertJurisdictionData,
    onPersist?: (tx: PrismaTransactionClient, saved: JurisdictionRow) => Promise<void>,
  ): Promise<JurisdictionRow> {
    // `UpsertJurisdictionData` mirrors the Zod-inferred request body, so its
    // optional fields carry an explicit `| undefined`. Spreading that straight
    // into Prisma's create/update input fails under `exactOptionalPropertyTypes`
    // — the generated inputs accept a key being ABSENT or `T | null`, never
    // present-and-`undefined` (TS-501). Stripping the undefined-valued keys
    // here states at the type level what the spread already did at runtime:
    // an omitted field is not written.
    const patch = definedEntriesOnly(data);
    const args = {
      where: { stateCode },
      create: { stateCode, ...patch },
      update: { ...patch },
      select: JURISDICTION_SELECT,
    };

    if (onPersist === undefined) {
      return this.prisma.mandatedReporterJurisdiction.upsert(args);
    }

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const saved = await tx.mandatedReporterJurisdiction.upsert(args);
      await onPersist(tx, saved);
      return saved;
    });
  }

  /**
   * Record or withdraw compliance's attestation. Attribution is written
   * together with the flag — the DB CHECK rejects a verified row with no
   * `verified_at` / `verified_by_user_id`, so the two can never drift.
   */
  async setJurisdictionVerification(
    stateCode: string,
    data: SetJurisdictionVerificationData,
    onPersist?: (tx: PrismaTransactionClient, saved: JurisdictionRow) => Promise<void>,
  ): Promise<JurisdictionRow> {
    const args = {
      where: { stateCode },
      data: {
        verified: data.verified,
        verifiedAt: data.verifiedAt,
        verifiedByUserId: data.verifiedByUserId,
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      },
      select: JURISDICTION_SELECT,
    };

    if (onPersist === undefined) {
      return this.prisma.mandatedReporterJurisdiction.update(args);
    }

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const saved = await tx.mandatedReporterJurisdiction.update(args);
      await onPersist(tx, saved);
      return saved;
    });
  }

  async findCaseByIncidentId(incidentId: string): Promise<MandatedReporterCaseRow | null> {
    return this.prisma.mandatedReporterCase.findUnique({
      where: { incidentId },
      select: CASE_SELECT,
    });
  }

  async findCaseById(id: string): Promise<MandatedReporterCaseRow | null> {
    return this.prisma.mandatedReporterCase.findUnique({
      where: { id },
      select: CASE_SELECT,
    });
  }

  /**
   * The operator queue (TS-303c2a) — the read
   * `trust_safety_mandated_reporter_cases_status_idx` was cut for in TS-303a
   * ("the operator queue's dominant scroll: open cases by status").
   *
   * `status` absent means every case except the terminal one: the queue is
   * live statutory work, and a signed-off case is finished. `NOT signed_off`
   * rather than an IN-list of the other four so a future status is included by
   * default — a new state nobody remembered to add to a whitelist would
   * silently drop elder-abuse cases out of the queue.
   *
   * **Ordering.** `statutoryDueAt` ASC NULLS FIRST, then `openedAt` ASC. Nulls
   * lead deliberately: a null deadline means the state's statutory window has
   * never been established, so the case has no clock at all — the one most
   * likely to be forgotten. It surfaces at the top rather than ageing out
   * below three years of dated rows.
   */
  async listCases(
    filter: ListMandatedReporterCasesFilter,
  ): Promise<MandatedReporterCaseSummaryRow[]> {
    return this.prisma.mandatedReporterCase.findMany({
      where: {
        ...(filter.status !== undefined
          ? { status: filter.status }
          : { status: { not: MANDATED_REPORTER_TERMINAL_STATUS } }),
        ...(filter.stateCode !== undefined ? { stateCode: filter.stateCode } : {}),
      },
      orderBy: [{ statutoryDueAt: { sort: 'asc', nulls: 'first' } }, { openedAt: 'asc' }],
      take: filter.limit,
      select: CASE_SUMMARY_SELECT,
    });
  }

  /**
   * Insert a case. When `onPersist` is provided the insert runs inside a
   * `$transaction` and the hook receives the tx client + the created row —
   * the audit-emission seam (TS-303b): the `audit.action_recorded` append
   * commits atomically with the case or not at all (CLAUDE.md §3.6, §5.3).
   * Mirrors `IncidentRepository.insert`.
   */
  async insertCase(
    data: InsertMandatedReporterCaseData,
    onPersist?: (tx: PrismaTransactionClient, created: MandatedReporterCaseRow) => Promise<void>,
  ): Promise<MandatedReporterCaseRow> {
    const createArgs = {
      data: {
        incidentId: data.incidentId,
        stateCode: data.stateCode,
        openedByUserId: data.openedByUserId,
        openedAt: data.openedAt,
        statutoryDueAt: data.statutoryDueAt,
        determinationNotes: data.determinationNotes,
        // `status` intentionally omitted — the DB default (`screening`) is
        // the single source of the initial state.
      },
      select: CASE_SELECT,
    };

    if (onPersist === undefined) {
      return this.prisma.mandatedReporterCase.create(createArgs);
    }

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = await tx.mandatedReporterCase.create(createArgs);
      await onPersist(tx, created);
      return created;
    });
  }

  /**
   * Apply a transition. The `where` carries `status: expectedFrom` so the
   * update is a compare-and-swap: two operators acting on the same case
   * concurrently cannot both believe they won, and the loser gets zero rows
   * rather than silently overwriting the winner's decision. Returns null on
   * a lost race so the service can surface a conflict.
   *
   * The whole thing runs in one transaction when `onPersist` is supplied, so
   * the audit event and the transition commit together. A lost race
   * short-circuits BEFORE the hook runs — no audit row is written for a
   * transition that did not happen.
   */
  async updateCase(
    id: string,
    expectedFrom: MandatedReporterCaseStatus,
    data: UpdateMandatedReporterCaseData,
    onPersist?: (tx: PrismaTransactionClient, updated: MandatedReporterCaseRow) => Promise<void>,
  ): Promise<MandatedReporterCaseRow | null> {
    if (onPersist === undefined) {
      const result = await this.prisma.mandatedReporterCase.updateMany({
        where: { id, status: expectedFrom },
        data: { ...data },
      });
      if (result.count === 0) return null;
      return this.findCaseById(id);
    }

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const result = await tx.mandatedReporterCase.updateMany({
        where: { id, status: expectedFrom },
        data: { ...data },
      });
      if (result.count === 0) return null;
      const updated = await tx.mandatedReporterCase.findUnique({
        where: { id },
        select: CASE_SELECT,
      });
      if (updated === null) return null;
      await onPersist(tx, updated);
      return updated;
    });
  }
}

/**
 * Copy `source` without the keys whose value is `undefined`.
 *
 * The returned type makes each key optional and removes `undefined` from its
 * value type, which is exactly the shape Prisma's generated create/update
 * inputs accept under `exactOptionalPropertyTypes`.
 */
function definedEntriesOnly<T extends object>(
  source: T,
): {
  [K in keyof T]?: Exclude<T[K], undefined>;
} {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
