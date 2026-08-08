/**
 * In-memory Prisma fake for the mandated-reporter unit tests (TS-303a).
 * Implements only the narrow surface `MandatedReporterRepository` consumes:
 * `mandatedReporterJurisdiction.findUnique` and
 * `mandatedReporterCase.{findUnique,findMany,create,updateMany}` with explicit
 * `select` projection.
 *
 * `updateMany` reproduces the compare-and-swap semantics the repository
 * relies on — it matches on BOTH `id` and the expected `status` and returns
 * `{ count: 0 }` when the status has moved, which is how a lost race is
 * detected. The DB CHECK constraints (signoff attribution, reviewer distinct
 * from opener, uppercase state codes) are NOT modelled here; those are
 * Postgres's job and land with the Testcontainers integration suite (a
 * carried followup). Excluded from build + coverage globs (`__fixtures__/`).
 */

type Row = Record<string, unknown>;

/** Monotonic clock — strictly-increasing timestamps without `Date.now()`. */
let tick = 0;
function nextDate(): Date {
  tick += 1;
  return new Date(Date.UTC(2026, 6, 24, 0, 0, tick));
}

function project(row: Row, select: Record<string, boolean> | undefined): Row {
  if (select === undefined) return { ...row };
  const projected: Row = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) projected[field] = row[field];
  }
  return projected;
}

export interface FakeJurisdictionSeed {
  readonly stateCode: string;
  readonly verified?: boolean;
  readonly statutoryDeadlineHours?: number | null;
  readonly platformRole?: string;
}

export class FakeMandatedReporterPrisma {
  jurisdictions: Row[] = [];
  cases: Row[] = [];
  private counter = 0;

  /**
   * Naive `$transaction` (TS-303b): runs the callback against this same fake
   * and restores the case set if it throws — enough to assert "an audit-emit
   * failure leaves no case behind" at the unit level. Real rollback semantics
   * are Postgres's job (the Testcontainers integration followup). Mirrors
   * `FakeIncidentsPrisma`.
   */
  async $transaction<T>(fn: (tx: FakeMandatedReporterPrisma) => Promise<T>): Promise<T> {
    const caseSnapshot = this.cases.map((row) => ({ ...row }));
    const jurisdictionSnapshot = this.jurisdictions.map((row) => ({ ...row }));
    try {
      return await fn(this);
    } catch (err) {
      // Both sets are copied per-row, not just per-array: an in-place UPDATE
      // must roll back too, not only an insert (the bug found in
      // `FakeIncidentsPrisma` during TS-303b).
      this.cases = caseSnapshot;
      this.jurisdictions = jurisdictionSnapshot;
      throw err;
    }
  }

  seedJurisdiction(seed: FakeJurisdictionSeed): void {
    this.jurisdictions.push({
      stateCode: seed.stateCode,
      agencyName: null,
      reportingPhone: null,
      reportingUrl: null,
      statutoryDeadlineHours: seed.statutoryDeadlineHours ?? null,
      platformRole: seed.platformRole ?? 'undetermined',
      statuteCitation: null,
      verified: seed.verified ?? false,
      verifiedAt: null,
      verifiedByUserId: null,
      notes: null,
    });
  }

  readonly mandatedReporterJurisdiction = {
    findUnique: ({
      where,
      select,
    }: {
      where: { stateCode: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => {
      const row = this.jurisdictions.find((c) => c['stateCode'] === where.stateCode);
      return Promise.resolve(row === undefined ? null : project(row, select));
    },

    findMany: ({
      where,
      select,
    }: {
      where?: { verified?: boolean };
      orderBy?: unknown;
      select?: Record<string, boolean>;
    }): Promise<Row[]> => {
      const rows = this.jurisdictions
        .filter((c) => where?.verified === undefined || c['verified'] === where.verified)
        .sort((a, b) => String(a['stateCode']).localeCompare(String(b['stateCode'])));
      return Promise.resolve(rows.map((row) => project(row, select)));
    },

    upsert: ({
      where,
      create,
      update,
      select,
    }: {
      where: { stateCode: string };
      create: Row;
      update: Row;
      select?: Record<string, boolean>;
    }): Promise<Row> => {
      const existing = this.jurisdictions.find((c) => c['stateCode'] === where.stateCode);
      if (existing === undefined) {
        const row: Row = {
          agencyName: null,
          reportingPhone: null,
          reportingUrl: null,
          statutoryDeadlineHours: null,
          platformRole: 'undetermined',
          statuteCitation: null,
          verified: false,
          verifiedAt: null,
          verifiedByUserId: null,
          notes: null,
          ...create,
        };
        this.jurisdictions.push(row);
        return Promise.resolve(project(row, select));
      }
      Object.assign(existing, update);
      return Promise.resolve(project(existing, select));
    },

    update: ({
      where,
      data,
      select,
    }: {
      where: { stateCode: string };
      data: Row;
      select?: Record<string, boolean>;
    }): Promise<Row> => {
      const existing = this.jurisdictions.find((c) => c['stateCode'] === where.stateCode);
      if (existing === undefined) throw new Error('jurisdiction not found');
      Object.assign(existing, data);
      return Promise.resolve(project(existing, select));
    },
  };

  readonly mandatedReporterCase = {
    create: ({ data, select }: { data: Row; select?: Record<string, boolean> }): Promise<Row> => {
      this.counter += 1;
      const row: Row = {
        id: `mrc_${this.counter}`,
        status: 'screening',
        statutoryDueAt: null,
        filedAt: null,
        filingReference: null,
        determinationNotes: null,
        reviewerUserId: null,
        reviewedAt: null,
        reviewerNotes: null,
        createdAt: nextDate(),
        updatedAt: nextDate(),
        ...data,
      };
      this.cases.push(row);
      return Promise.resolve(project(row, select));
    },

    findUnique: ({
      where,
      select,
    }: {
      where: { id?: string; incidentId?: string };
      select?: Record<string, boolean>;
    }): Promise<Row | null> => {
      const row = this.cases.find((c) =>
        where.id !== undefined ? c['id'] === where.id : c['incidentId'] === where.incidentId,
      );
      return Promise.resolve(row === undefined ? null : project(row, select));
    },

    /**
     * Queue read (TS-303c2a). Reproduces the two behaviours the repository
     * relies on and the tests assert: the `status: { not: 'signed_off' }`
     * default filter, and the `statutoryDueAt` ASC **NULLS FIRST** →
     * `openedAt` ASC ordering. Prisma's `nulls: 'first'` is a real ordering
     * knob, so a fake that sorted nulls last would let the queue's most
     * important property pass a test while failing in Postgres.
     */
    findMany: ({
      where,
      take,
      select,
    }: {
      where?: {
        status?: string | { not: string };
        stateCode?: string;
      };
      orderBy?: unknown;
      take?: number;
      select?: Record<string, boolean>;
    }): Promise<Row[]> => {
      const statusFilter = where?.status;
      const rows = this.cases
        .filter((c) => {
          if (statusFilter !== undefined) {
            if (typeof statusFilter === 'string') {
              if (c['status'] !== statusFilter) return false;
            } else if (c['status'] === statusFilter.not) {
              return false;
            }
          }
          if (where?.stateCode !== undefined && c['stateCode'] !== where.stateCode) return false;
          return true;
        })
        .sort((a, b) => {
          const dueA = a['statutoryDueAt'] as Date | null;
          const dueB = b['statutoryDueAt'] as Date | null;
          if (dueA === null && dueB !== null) return -1;
          if (dueA !== null && dueB === null) return 1;
          if (dueA !== null && dueB !== null && dueA.getTime() !== dueB.getTime()) {
            return dueA.getTime() - dueB.getTime();
          }
          const openedA = a['openedAt'] as Date;
          const openedB = b['openedAt'] as Date;
          return openedA.getTime() - openedB.getTime();
        });
      const limited = take === undefined ? rows : rows.slice(0, take);
      return Promise.resolve(limited.map((row) => project(row, select)));
    },

    updateMany: ({
      where,
      data,
    }: {
      where: { id: string; status: string };
      data: Row;
    }): Promise<{ count: number }> => {
      const row = this.cases.find((c) => c['id'] === where.id && c['status'] === where.status);
      if (row === undefined) return Promise.resolve({ count: 0 });
      Object.assign(row, data, { updatedAt: nextDate() });
      return Promise.resolve({ count: 1 });
    },
  };
}
