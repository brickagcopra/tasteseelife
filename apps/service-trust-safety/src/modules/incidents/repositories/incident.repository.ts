import { Injectable } from '@nestjs/common';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';
import type {
  IncidentCategory,
  IncidentSeverity,
  IncidentSource,
  IncidentStatus,
} from '../incident-enums';

/**
 * Explicit projection for every incident read/write (CLAUDE.md §4.1 — no
 * `SELECT *` in production paths). One shape for the whole skeleton; later
 * slices add narrower list projections as the operator queue lands (TS-301).
 */
const INCIDENT_SELECT = {
  id: true,
  householdId: true,
  seniorId: true,
  providerId: true,
  reporterUserId: true,
  source: true,
  category: true,
  severity: true,
  status: true,
  description: true,
  openedAt: true,
  slaDueAt: true,
  resolvedAt: true,
  resolutionNotes: true,
  // TS-307a shipped the column, the partial UNIQUE and the input field —
  // but never projected or wrote it (TS-307a-followup-1). Selected here
  // so the detail read can surface the handle that ties an incident to
  // its event.
  sourceEventId: true,
  // TS-308c-followup-2 — the system-intake evidence pair.
  detector: true,
  systemFacts: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Queue projection (TS-303c2d). `description` and `resolutionNotes` are absent
 * BY DESIGN, and the absence is enforced here in the SQL rather than trimmed
 * in a mapper: the filer's free-text account of what happened to a named
 * senior never leaves Postgres for a list read at all (CLAUDE.md §3.9, §4.1).
 */
const INCIDENT_SUMMARY_SELECT = {
  id: true,
  householdId: true,
  seniorId: true,
  providerId: true,
  reporterUserId: true,
  source: true,
  category: true,
  severity: true,
  status: true,
  openedAt: true,
  slaDueAt: true,
  resolvedAt: true,
  mandatedReporterCase: { select: { id: true } },
  // NOT `as const`: a nested relation select under a deeply-readonly object
  // defeats Prisma's result-type inference and silently degrades the row type
  // to `any`, which is exactly the guarantee this projection exists to make.
};

/** The persisted incident row, projected through `INCIDENT_SELECT`. */
export interface IncidentRow {
  readonly id: string;
  readonly householdId: string | null;
  readonly seniorId: string | null;
  readonly providerId: string | null;
  /**
   * The verified `userId` of the filer (TS-301b), stamped from the access
   * token by the intake surface. Null on system-sourced incidents.
   */
  readonly reporterUserId: string | null;
  readonly source: IncidentSource;
  readonly category: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  /**
   * The filer's free-text report (TS-301a). PII/PHI — surfaced only through
   * authorised ops reads; never on events or logs.
   */
  readonly description: string | null;
  readonly openedAt: Date;
  readonly slaDueAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionNotes: string | null;
  /** TS-307a's domain idempotency key; null for every human-filed report. */
  readonly sourceEventId: string | null;
  /** TS-308c-followup-2 — which detector opened this; null when human-filed. */
  readonly detector: string | null;
  /**
   * TS-308c-followup-2 — the detector's evidence as stored.
   *
   * `unknown`, not a typed shape, because that is the honest type of a
   * JSONB column read back: what is in the row is whatever a previous
   * build wrote, and a stored blob CAN fail to parse against today's
   * contract. The read path narrows it with `safeParse` and degrades to
   * null on failure rather than 500-ing an operator out of an incident.
   */
  readonly systemFacts: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A queue row — {@link IncidentRow} minus the two free-text fields, the
 * system-intake trail, and the row timestamps an operator does not triage on,
 * plus the statutory-pathway flag.
 *
 * The system-evidence pair is absent for the same reason `description` is:
 * the queue projection never fetches it, so the row type must not claim it.
 * A list read has no business pulling a JSONB blob per row for a column
 * nothing in the queue renders.
 */
export type IncidentSummaryRow = Omit<
  IncidentRow,
  | 'description'
  | 'resolutionNotes'
  | 'sourceEventId'
  | 'detector'
  | 'systemFacts'
  | 'createdAt'
  | 'updatedAt'
> & {
  readonly hasMandatedReporterCase: boolean;
};

/** The full detail row: everything on the incident, plus the pathway flag. */
export type IncidentDetailRow = IncidentRow & {
  readonly hasMandatedReporterCase: boolean;
};

/**
 * Operator-queue filter (TS-303c2d). `status` absent means "every unresolved
 * incident" — see `list`.
 */
export interface ListIncidentsFilter {
  readonly status?: IncidentStatus | undefined;
  readonly severity?: IncidentSeverity | undefined;
  readonly category?: IncidentCategory | undefined;
  readonly householdId?: string | undefined;
  readonly seniorId?: string | undefined;
  readonly providerId?: string | undefined;
  readonly limit: number;
}

export interface InsertIncidentData {
  readonly householdId: string | null;
  readonly seniorId: string | null;
  readonly providerId: string | null;
  readonly reporterUserId: string | null;
  readonly source: IncidentSource;
  readonly category: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly description: string | null;
  readonly openedAt: Date;
  readonly slaDueAt: Date;
  /**
   * TS-307a's domain idempotency key. Null for every human-filed report.
   *
   * **Not optional, deliberately.** It was absent from this interface
   * entirely until TS-307a-followup-1, which meant the value the consumer
   * handlers passed to `createIncident` was silently dropped here and the
   * partial UNIQUE guarded a column that was always NULL. Making it a
   * required field means the next caller cannot forget it without a
   * compile error.
   */
  readonly sourceEventId: string | null;
  /** TS-308c-followup-2 — which detector opened this; null when human-filed. */
  readonly detector: string | null;
  /**
   * TS-308c-followup-2 — the detector's evidence, ALREADY VALIDATED against
   * `TrustSafetySystemEvidenceSchema` by the service. The repository does
   * not validate; it also must never be handed anything that has not been.
   */
  readonly systemFacts: unknown;
}

/**
 * Persistence for `trust_safety.incidents`. Repositories own persistence;
 * the service layer owns the domain logic (SLA computation, validation) —
 * CLAUDE.md §2.3.
 *
 * Every operation flows through the DI-injected tenant-scoped Prisma client
 * (TS-141 `enforce` mode): a call outside a request/exempt frame throws
 * `MissingRequestContextError` before it reaches Postgres.
 */
@Injectable()
export class IncidentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insert an incident. When `onPersist` is provided the insert runs inside
   * a `$transaction` and the hook receives the tx client + the created row —
   * the outbox-emission seam (TS-301a): the `trust_safety.incident.created`
   * append commits atomically with the insert or not at all (CLAUDE.md §5.3;
   * mirrors the content repository's `onPersist` shape).
   */
  async insert(
    data: InsertIncidentData,
    onPersist?: (tx: PrismaTransactionClient, created: IncidentRow) => Promise<void>,
  ): Promise<IncidentRow> {
    const createArgs = {
      data: {
        householdId: data.householdId,
        seniorId: data.seniorId,
        providerId: data.providerId,
        reporterUserId: data.reporterUserId,
        source: data.source,
        category: data.category,
        severity: data.severity,
        description: data.description,
        // `status` intentionally omitted — the DB default (`open`) is the
        // single source of the initial state.
        openedAt: data.openedAt,
        slaDueAt: data.slaDueAt,
        sourceEventId: data.sourceEventId,
        detector: data.detector,
        // `undefined` rather than `null` when there is no evidence: Prisma
        // treats an explicit `null` on a `Json?` field as the JSON literal
        // `null`, which is a VALUE and not the absence of one. A human-filed
        // report must leave the column SQL NULL so `systemFacts !== null`
        // stays a truthful "a detector recorded something".
        ...(data.systemFacts === null || data.systemFacts === undefined
          ? {}
          : { systemFacts: data.systemFacts as object }),
      },
      select: INCIDENT_SELECT,
    };

    if (onPersist === undefined) {
      return this.prisma.incident.create(createArgs);
    }

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const created = await tx.incident.create(createArgs);
      await onPersist(tx, created);
      return created;
    });
  }

  async findById(id: string): Promise<IncidentRow | null> {
    return this.prisma.incident.findUnique({
      where: { id },
      select: INCIDENT_SELECT,
    });
  }

  /**
   * The operator queue (TS-303c2d) — the read TS-300's partial index
   * `trust_safety_incidents_unresolved_sla_idx` was cut for.
   *
   * `status` absent means every incident that is not `resolved`, expressed as
   * a NOT rather than an IN-list so a status added later is included by
   * default. The default case is exactly the partial index's predicate, so it
   * scans the small live set rather than the whole table.
   *
   * Ordered by `slaDueAt` ascending — soonest deadline first. Non-nullable, so
   * unlike the mandated-reporter queue there is no null-ordering question.
   *
   * The mandated-reporter case is projected down to its `id` alone. The
   * surfaces only need the boolean "is this in the statutory pathway"
   * (i.e. it cannot be closed), and the case row carries `determinationNotes`
   * / `reviewerNotes` — a second confidential record that has no business
   * riding along on an incident read. Prisma's `_count` is not available here
   * because the relation is one-to-one, so the narrow select IS the mechanism,
   * not just a preference.
   */
  async list(filter: ListIncidentsFilter): Promise<IncidentSummaryRow[]> {
    const rows: readonly ProjectedSummaryRow[] = await this.prisma.incident.findMany({
      where: {
        // `status` absent narrows to unresolved rows, expressed as a NOT
        // rather than an IN-list of the other three so a status added later is
        // included by default — a new state nobody remembered to add to a
        // whitelist would silently drop live incidents out of the queue. That
        // default is also exactly the predicate of the partial index
        // `trust_safety_incidents_unresolved_sla_idx` (CLAUDE.md §7.3).
        ...(filter.status !== undefined
          ? { status: filter.status }
          : { status: { not: 'resolved' } }),
        ...(filter.severity !== undefined ? { severity: filter.severity } : {}),
        ...(filter.category !== undefined ? { category: filter.category } : {}),
        ...(filter.householdId !== undefined ? { householdId: filter.householdId } : {}),
        ...(filter.seniorId !== undefined ? { seniorId: filter.seniorId } : {}),
        ...(filter.providerId !== undefined ? { providerId: filter.providerId } : {}),
      },
      orderBy: [{ slaDueAt: 'asc' }, { openedAt: 'asc' }],
      take: filter.limit,
      select: INCIDENT_SUMMARY_SELECT,
    });

    return rows.map(toSummaryRow);
  }

  /**
   * One incident, with the free-text fields and the statutory-pathway flag,
   * so the detail surface can say "this cannot be closed" without a second
   * call. See `list` for why the case is projected to its id.
   */
  async findDetailById(id: string): Promise<IncidentDetailRow | null> {
    const row: (IncidentRow & MandatedReporterCaseProbe) | null =
      await this.prisma.incident.findUnique({
        where: { id },
        select: { ...INCIDENT_SELECT, mandatedReporterCase: { select: { id: true } } },
      });
    if (row === null) return null;
    const { mandatedReporterCase, ...rest } = row;
    return { ...rest, hasMandatedReporterCase: mandatedReporterCase !== null };
  }

  /**
   * Close an incident (TS-303b). The `where` excludes already-resolved rows,
   * making this a compare-and-swap: a double-submit or a race between two
   * operators resolves once and the loser gets null, rather than overwriting
   * the first resolution's notes and timestamp.
   *
   * `onPersist` is the audit-emission seam — the `audit.action_recorded`
   * append commits atomically with the closure (CLAUDE.md §3.6, §5.3). A lost
   * race short-circuits before the hook, so no audit row claims a closure that
   * did not happen.
   */
  async resolve(
    id: string,
    data: { readonly resolvedAt: Date; readonly resolutionNotes: string },
    onPersist?: (tx: PrismaTransactionClient, resolved: IncidentRow) => Promise<void>,
  ): Promise<IncidentRow | null> {
    const apply = async (client: PrismaTransactionClient): Promise<IncidentRow | null> => {
      const result = await client.incident.updateMany({
        where: { id, status: { not: 'resolved' } },
        data: {
          status: 'resolved',
          resolvedAt: data.resolvedAt,
          resolutionNotes: data.resolutionNotes,
        },
      });
      if (result.count === 0) return null;
      return client.incident.findUnique({ where: { id }, select: INCIDENT_SELECT });
    };

    if (onPersist === undefined) {
      return apply(this.prisma as unknown as PrismaTransactionClient);
    }

    return this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const resolved = await apply(tx);
      if (resolved === null) return null;
      await onPersist(tx, resolved);
      return resolved;
    });
  }
}

/**
 * The one-to-one mandated-reporter case, projected to nothing but its
 * existence. Null when the incident was never routed into the statutory
 * pathway.
 */
interface MandatedReporterCaseProbe {
  readonly mandatedReporterCase: { readonly id: string } | null;
}

/**
 * The shape `INCIDENT_SUMMARY_SELECT` projects.
 *
 * The omit list must match `IncidentSummaryRow`'s exactly: the queue select
 * deliberately does not fetch `sourceEventId` / `detector` / `systemFacts`
 * (see the note on `IncidentSummaryRow`), and this type previously claimed
 * all three. Nothing caught it while `@prisma/client` resolved to the model-
 * less stub — `findMany` returned `any`, so the annotation was never checked
 * against the real projection (TS-501).
 */
type ProjectedSummaryRow = Omit<
  IncidentRow,
  | 'description'
  | 'resolutionNotes'
  | 'sourceEventId'
  | 'detector'
  | 'systemFacts'
  | 'createdAt'
  | 'updatedAt'
> &
  MandatedReporterCaseProbe;

/**
 * Collapse the case probe to the boolean the surfaces actually use.
 *
 * The return types here are annotated rather than inferred throughout this
 * file's read paths. That was originally a workaround for `@prisma/client`
 * resolving to the model-less stub; since TS-501 the service imports its own
 * generated client, so the annotations are now genuinely checked against the
 * projection rather than merely documenting it.
 */
function toSummaryRow(row: ProjectedSummaryRow): IncidentSummaryRow {
  const { mandatedReporterCase, ...rest } = row;
  return { ...rest, hasMandatedReporterCase: mandatedReporterCase !== null };
}
